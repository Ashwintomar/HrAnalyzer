// Processing Manager for Worker Thread Pool - SINGLETON EDITION
// Manages parallel processing of multiple resumes with global state persistence

const { Worker } = require('worker_threads');
const path = require('path');
const Database = require('better-sqlite3');
const modelCompatibilityChecker = require('./embeddingAligner');
const contactParser = require('./contactParser');
const { ProcessingRunState } = require('./processingRunState');
const { ensureRuntimeDirectories, getDatabasePath } = require('./runtimePaths');

class ProcessingManager {
    constructor(maxWorkers = 4) {
        // SINGLETON ENFORCEMENT
        if (ProcessingManager.instance) {
            return ProcessingManager.instance;
        }

        // Allow override via environment variable MAX_WORKERS (must be >=1)
        const envMax = parseInt(process.env.MAX_WORKERS, 10);
        this.maxWorkers = (!isNaN(envMax) && envMax >= 1) ? envMax : maxWorkers;
        
        this.workers = [];
        this.taskQueue = [];
        this.activeTasks = new Map();
        this.taskIdCounter = 0;
        this.completedTasks = 0;
        this.memoryLogInterval = null;
        this.shuttingDown = false;
        this.runState = new ProcessingRunState({
            onReset: () => this.resetGlobalState()
        });
        this.embeddingPermitSignature = null;

        // GLOBAL STATE FOR UI PERSISTENCE
        this.globalState = {
            activeJobType: null, // 'ANALYZER', 'GMAIL', 'SCRIPT' or null
            statusMessage: 'Idle',
            progress: 0,
            total: 0,
            processed: 0,
            startTime: null
        };

        // Embedding concurrency control
        this.embeddingPermitsTotal = 0;
        this.embeddingPermitsAvailable = 0;
        this.embeddingPermitQueue = [];
        this._tasksWithPermit = new Set();
        
        // Database connection
        ensureRuntimeDirectories();
        this.db = new Database(getDatabasePath());
        
        // Check if vector extension is available
        this.vectorExtensionAvailable = false;
        try {
            const { load } = require('sqlite-vec');
            load(this.db);
            this.vectorExtensionAvailable = true;
            console.log('✅ sqlite-vec loaded in ProcessingManager');
        } catch (error) {
            console.log('⚠️ sqlite-vec not available in ProcessingManager');
        }
        
        // Prepare SQL statements
        this.insertResumeStmt = this.db.prepare(`
            INSERT INTO Resumes (candidate_id, content, embedding, embedding_json, local_file_path, embedding_model)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        this.getCandidateStmt = this.db.prepare(`SELECT id, name, email, phone, resume_url FROM Candidates WHERE id = ?`);
        this.updateCandidatePartialStmt = this.db.prepare(`UPDATE Candidates SET 
            name = COALESCE(@name, name),
            email = COALESCE(@email, email),
            phone = COALESCE(@phone, phone)
        WHERE id = @id`);

        ProcessingManager.instance = this;
    }
    
    // Initialize worker pool (Idempotent - safe to call multiple times)
    async initializeWorkers(workerPath) {
        if (this.workers.length > 0) {
            return; // Already initialized
        }

        console.log(`Initializing ${this.maxWorkers} worker thread${this.maxWorkers === 1 ? '' : 's'}...`);
        
        const actualWorkerPath = workerPath || path.join(__dirname, '../workers/resumeProcessor.js');
        
        for (let i = 0; i < this.maxWorkers; i++) {
            const worker = new Worker(actualWorkerPath);
            
            worker.on('message', (message) => {
                this.handleWorkerMessage(worker, message);
            });
            
            worker.on('error', (error) => {
                console.error(`Worker ${worker.threadId} error:`, error);
                this.handleWorkerFailure(worker, error);
            });
            
            worker.on('exit', (code) => {
                if (this.shuttingDown) return;
                if (code !== 0) {
                    console.error(`Worker ${worker.threadId} exited with code ${code}`);
                    this.handleWorkerFailure(worker, new Error(`Worker exited with code ${code}`));
                }
            });
            
            this.workers.push({
                worker,
                busy: false,
                id: i
            });
        }
        
        console.log('Worker pool initialized successfully');

        if (process.env.ENABLE_MEMORY_LOGGING === '1') {
            this.startMemoryLogging();
        }
    }

    // --- STATE MANAGEMENT ---

    updateGlobalState(type, message, processed, total) {
        this.globalState.activeJobType = type;
        this.globalState.statusMessage = message;
        this.globalState.processed = processed;
        this.globalState.total = total;
        this.globalState.progress = total > 0 ? Math.round((processed / total) * 100) : 0;
        if (!this.globalState.startTime) this.globalState.startTime = Date.now();
    }

    resetGlobalState() {
        this.globalState = {
            activeJobType: null,
            statusMessage: 'Idle',
            progress: 0,
            total: 0,
            processed: 0,
            startTime: null
        };
    }

    getGlobalState() {
        return this.globalState;
    }
    
    // Process multiple resumes in parallel (Legacy wrapper)
    async processResumes(resumeData, progressCallback, embeddingConfig) {
        // For legacy calls, assume ANALYZER type
        return this.submitTasks(resumeData, progressCallback, embeddingConfig, 'ANALYZER');
    }

    // Submit tasks to the queue
    async submitTasks(resumeData, progressCallback, embeddingConfig, jobType = 'ANALYZER') {
        const safeResumeData = Array.isArray(resumeData) ? resumeData : [];
        if (safeResumeData.length === 0) {
            return [];
        }

        this.runState.clearReset();
        this._configureEmbeddingPermitsForRun(embeddingConfig);

        const runSnapshot = this.runState.startRun({ jobType, total: safeResumeData.length });

        // Initialize Global State
        this.updateGlobalState(jobType, 'Starting processing...', 0, safeResumeData.length);

        const tasks = safeResumeData.map(data => ({
            id: ++this.taskIdCounter,
            data: { ...data, embeddingConfig },
            resolve: null,
            reject: null,
            progressCallback,
            runId: runSnapshot.id
        }));
        
        const promises = tasks.map(task => {
            return new Promise((resolve, reject) => {
                task.resolve = resolve;
                task.reject = reject;
                this.taskQueue.push(task);
            });
        });
        
        // Start processing
        this.processQueue();

        // Wrap promises to update state on completion
        const wrappedPromises = promises.map((p, index) => p.then(res => {
            const snapshot = this.runState.markCompleted(tasks[index].runId);
            if (snapshot) {
                this.updateGlobalState(jobType, 'Processing...', snapshot.completed, snapshot.total);
            }
            return res;
        }).catch(err => {
            const snapshot = this.runState.markCompleted(tasks[index].runId);
            if (snapshot) {
                this.updateGlobalState(jobType, 'Processing...', snapshot.completed, snapshot.total);
            }
            throw err;
        }));
        
        // Wait for all tasks to complete
        const results = await Promise.allSettled(wrappedPromises);
        
        // Reset state after short delay
        this.runState.scheduleReset(runSnapshot.id, 5000, () => this.activeTasks.size === 0 && this.taskQueue.length === 0);

        return results.map((result, index) => {
            const base = { taskId: tasks[index].id };
            if (result.status === 'fulfilled') {
                const value = result.value;
                if (value && value.skipped) {
                    return { ...base, success: false, skipped: true, data: value, error: null };
                }
                return { ...base, success: true, skipped: false, data: value, error: null };
            } else {
                return { ...base, success: false, skipped: false, data: null, error: result.reason };
            }
        });
    }
    
    // Process task queue
    processQueue() {
        if (this.taskQueue.length === 0) return;

        let assigned = 0;
        while (this.taskQueue.length > 0) {
            const availableWorker = this.workers.find(w => !w.busy);
            if (!availableWorker) break;

            // Memory pressure check
            const rssMB = process.memoryUsage().rss / 1024 / 1024;
            const limitMB = parseInt(process.env.MEMORY_RSS_SOFT_LIMIT_MB || '0', 10);
            if (limitMB > 0 && rssMB > limitMB) {
                if (!this._throttledLog || Date.now() - this._throttledLog > 5000) {
                    console.warn(`⚠️ Memory soft limit reached (${rssMB.toFixed(1)}MB > ${limitMB}MB). Delaying new task assignment...`);
                    this._throttledLog = Date.now();
                }
                setTimeout(() => this.processQueue(), 1000);
                break;
            }

            const task = this.taskQueue.shift();
            this.assignTaskToWorker(availableWorker, task);
            assigned++;
        }

        if (assigned === 0 && this.taskQueue.length > 0) return;
    }
    
    // Assign task to worker
    assignTaskToWorker(workerInfo, task) {
        workerInfo.busy = true;
        this.activeTasks.set(task.id, { workerInfo, task });
        
        workerInfo.worker.postMessage({
            type: 'process',
            taskId: task.id,
            ...task.data
        });
    }
    
    // Handle messages from workers
    handleWorkerMessage(worker, message) {
        const { type, taskId } = message;
        
        if (type === 'ready') return;

        if (type === 'ready_to_embed') {
            this._grantOrQueueEmbedPermit(worker, taskId);
            return;
        }
        
        const activeTask = this.activeTasks.get(taskId);
        if (!activeTask) return;
        
        const { workerInfo, task } = activeTask;
        
        switch (type) {
            case 'progress':
                if (task.progressCallback) {
                    task.progressCallback({
                        taskId,
                        message: message.message,
                        candidateId: message.candidateId,
                        stats: this.runState.getSnapshot(task.runId)
                    });
                }
                break;
            case 'extracted_info':
                try {
                    const { candidateId, extractedInfo } = message;
                    if (candidateId && extractedInfo && typeof extractedInfo === 'object') {
                        this._updateCandidateFromExtraction(candidateId, extractedInfo);
                    }
                } catch (e) {
                    console.warn('Failed to apply extracted_info to candidate:', e?.message || e);
                }
                break;
            case 'skip':
                if (task.progressCallback) {
                    const reason = message.reason || 'Skipped by worker';
                    task.progressCallback({ taskId, message: `Skipping candidate ${message.candidateId || ''}: ${reason}` });
                }
                this.handleTaskSkipped(taskId, { candidateId: message.candidateId, reason: message.reason });
                break;
            case 'success':
                this.handleTaskSuccess(taskId, message.result);
                break;
            case 'error':
                this.handleTaskError(taskId, message.error);
                break;
        }
    }

    _updateCandidateFromExtraction(candidateId, info) {
        const current = this.getCandidateStmt.get(candidateId);
        if (!current) return;

        const next = { id: candidateId, name: null, email: null, phone: null };

        if (info.name) {
            const extracted = this._sanitizeName(info.name);
            const isGeneric = this._isGenericName(current.name);
            if (extracted && (isGeneric || !current.name || current.name.length < 3)) {
                next.name = extracted;
            }
        }

        if (info.email) {
            const email = contactParser.normalizeEmail(String(info.email).trim());
            if (email && contactParser.isValidEmail(email)) {
                if (!current.email || current.email.length < 5) {
                    next.email = email;
                }
            }
        }

        if (info.phone) {
            const phone = contactParser.normalizePhone(String(info.phone).trim());
            if (phone && (!current.phone || current.phone.length < 7)) {
                next.phone = phone;
            }
        }

        if (next.name || next.email || next.phone) {
            try {
                this.updateCandidatePartialStmt.run(next);
            } catch (e) {
                console.warn('Candidate update failed:', e?.message || e);
            }
        }
    }

    _sanitizeName(name) {
        let n = String(name || '').trim();
        if (!n) return null;
        n = n.replace(/\s+/g, ' ').replace(/[^A-Za-z\s.'-]/g, '').trim();
        if (n.length < 2 || n.length > 80) return null;
        n = n.split(' ').filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        return n;
    }

    _isGenericName(name) {
        if (!name) return true;
        const n = String(name).trim();
        if (/^candidate\b/i.test(n)) return true;
        if (/^unknown$/i.test(n)) return true;
        if (n.length < 3) return true;
        return false;
    }
    
    async handleTaskSuccess(taskId, result) {
        const activeTask = this.activeTasks.get(taskId);
        if (!activeTask) return;

        const { workerInfo, task } = activeTask;
        const embeddingModel = (task.data.embeddingConfig && task.data.embeddingConfig.model) || 'unknown';

        try {
            const embedding = new Float32Array(result.embedding);
            const resumeResult = this.insertResumeStmt.run(
                result.candidateId,
                result.content,
                Buffer.from(embedding.buffer),
                JSON.stringify(result.embedding),
                result.localFilePath,
                embeddingModel
            );

            modelCompatibilityChecker.trackModelUsage('candidate', embeddingModel, result.candidateId.toString());

            task.resolve({
                id: resumeResult.lastInsertRowid,
                ...result
            });

        } catch (error) {
            console.error('Database error:', error);
            task.reject(error);
        }

        this._releaseEmbedPermit(taskId);
        this.finishTask(taskId, workerInfo);
    }

    handleTaskSkipped(taskId, info) {
        const activeTask = this.activeTasks.get(taskId);
        if (!activeTask) return;

        const { workerInfo, task } = activeTask;
        try {
            task.resolve({ skipped: true, ...info });
        } catch (e) {
            task.reject(e);
        }

        this._releaseEmbedPermit(taskId);
        this.finishTask(taskId, workerInfo);
    }
    
    handleTaskError(taskId, error) {
        const activeTask = this.activeTasks.get(taskId);
        if (!activeTask) return;
        
        const { workerInfo, task } = activeTask;
        task.reject(new Error(error));
        this._releaseEmbedPermit(taskId);
        this.finishTask(taskId, workerInfo);
    }
    
    finishTask(taskId, workerInfo) {
        workerInfo.busy = false;
        this.activeTasks.delete(taskId);
        this.completedTasks++;
        
        setTimeout(() => this.processQueue(), 0);
    }

    _setupEmbeddingPermits(embeddingConfig) {
        let totalPermits;
        if (embeddingConfig && embeddingConfig.mode === 'online') {
            const keysCount = Array.isArray(embeddingConfig.apiKeys) ? embeddingConfig.apiKeys.length : 0;
            totalPermits = Math.min(this.maxWorkers, Math.max(3, keysCount || 3));
        } else {
            const localDefault = parseInt(process.env.LOCAL_EMBEDDING_CONCURRENCY || '3', 10);
            totalPermits = Math.min(this.maxWorkers, Math.max(1, localDefault));
        }

        if (embeddingConfig && embeddingConfig.embeddingConcurrency) {
            const userN = parseInt(embeddingConfig.embeddingConcurrency, 10);
            if (!isNaN(userN) && userN > 0) {
                totalPermits = Math.min(this.maxWorkers, userN);
            }
        }

        const forced = parseInt(process.env.EMBEDDING_CONCURRENCY || '0', 10);
        if (!isNaN(forced) && forced > 0) {
            totalPermits = Math.min(this.maxWorkers, forced);
        }

        this.embeddingPermitsTotal = totalPermits;
        this.embeddingPermitsAvailable = totalPermits;
        this.embeddingPermitQueue = [];
        this._tasksWithPermit.clear();
        this.embeddingPermitSignature = this._getEmbeddingPermitSignature(embeddingConfig);
        console.log(`Embedding concurrency set to ${this.embeddingPermitsTotal} (max workers: ${this.maxWorkers})`);
    }

    _configureEmbeddingPermitsForRun(embeddingConfig) {
        const isIdle = this.activeTasks.size === 0 && this.taskQueue.length === 0;
        const nextSignature = this._getEmbeddingPermitSignature(embeddingConfig);

        if (this.embeddingPermitsTotal === 0 || isIdle) {
            this._setupEmbeddingPermits(embeddingConfig);
            return;
        }

        if (this.embeddingPermitSignature !== nextSignature) {
            console.log('Embedding concurrency settings changed while tasks were still active; current permit pool will stay in place until the queue drains.');
        }
    }

    _getEmbeddingPermitSignature(embeddingConfig) {
        const forced = parseInt(process.env.EMBEDDING_CONCURRENCY || '0', 10);
        const localDefault = parseInt(process.env.LOCAL_EMBEDDING_CONCURRENCY || '3', 10);

        return JSON.stringify({
            mode: embeddingConfig?.mode || 'local',
            apiKeyCount: Array.isArray(embeddingConfig?.apiKeys) ? embeddingConfig.apiKeys.length : 0,
            embeddingConcurrency: embeddingConfig?.embeddingConcurrency ?? null,
            forced: Number.isFinite(forced) ? forced : 0,
            localDefault: Number.isFinite(localDefault) ? localDefault : 3
        });
    }

    _grantOrQueueEmbedPermit(worker, taskId) {
        if (this.embeddingPermitsAvailable > 0) {
            this.embeddingPermitsAvailable--;
            this._tasksWithPermit.add(taskId);
            try {
                worker.postMessage({ type: 'embed-permit', taskId });
            } catch (e) {
                this._tasksWithPermit.delete(taskId);
                this.embeddingPermitsAvailable++;
            }
        } else {
            this.embeddingPermitQueue.push({ worker, taskId });
        }
    }

    _releaseEmbedPermit(taskId) {
        if (!this._tasksWithPermit.has(taskId)) return;
        this._tasksWithPermit.delete(taskId);
        const next = this.embeddingPermitQueue.shift();
        if (next) {
            this._tasksWithPermit.add(next.taskId);
            try {
                next.worker.postMessage({ type: 'embed-permit', taskId: next.taskId });
            } catch (e) {
                this._tasksWithPermit.delete(next.taskId);
                this.embeddingPermitsAvailable = Math.min(this.embeddingPermitsTotal, this.embeddingPermitsAvailable + 1);
            }
        } else {
            this.embeddingPermitsAvailable = Math.min(this.embeddingPermitsTotal, this.embeddingPermitsAvailable + 1);
        }
    }

    handleWorkerFailure(failedWorker, error) {
        let failedTaskId = null;
        for (const [taskId, activeTask] of this.activeTasks.entries()) {
            if (activeTask.workerInfo.worker === failedWorker) {
                failedTaskId = taskId;
                break;
            }
        }

        if (failedTaskId) {
            console.log(`Task ${failedTaskId} was running on the failed worker. Rejecting task.`);
            this.handleTaskError(failedTaskId, error.message || 'Worker failed unexpectedly.');
        }

        this.restartWorker(failedWorker);
    }

    getStats() {
        const latestRun = this.runState.getLatestSnapshot();
        return {
            total: latestRun ? latestRun.total : this.taskQueue.length + this.activeTasks.size,
            completed: latestRun ? latestRun.completed : 0,
            inProgress: this.activeTasks.size,
            queued: this.taskQueue.length
        };
    }
    
    restartWorker(failedWorker) {
        if (this.shuttingDown) return;
        const index = this.workers.findIndex(w => w.worker === failedWorker);
        if (index === -1) return;
        
        console.log(`Restarting worker ${index}...`);
        
        const newWorker = new Worker(path.join(__dirname, '../workers/resumeProcessor.js'));
        
        newWorker.on('message', (message) => {
            this.handleWorkerMessage(newWorker, message);
        });
        
        newWorker.on('error', (error) => {
            console.error(`Worker ${index} error:`, error);
            this.restartWorker(newWorker);
        });
        
        this.workers[index] = {
            worker: newWorker,
            busy: false,
            id: index
        };
    }

    startMemoryLogging() {
        if (this.memoryLogInterval) return;
        console.log('🧪 Memory logging enabled (ENABLE_MEMORY_LOGGING=1)');
        this.memoryLogInterval = setInterval(() => {
            const mu = process.memoryUsage();
            const fmt = v => (v / 1024 / 1024).toFixed(1) + 'MB';
            console.log(`[MEM] rss=${fmt(mu.rss)} heapUsed=${fmt(mu.heapUsed)} ext=${fmt(mu.external)} tasks active=${this.activeTasks.size} queued=${this.taskQueue.length}`);
        }, parseInt(process.env.MEMORY_LOG_INTERVAL_MS || '10000', 10));
        this.memoryLogInterval.unref();
    }

    stopMemoryLogging() {
        if (this.memoryLogInterval) {
            clearInterval(this.memoryLogInterval);
            this.memoryLogInterval = null;
        }
    }
    
    terminateAllWorkers() {
        console.log('Terminating all worker threads...');
        this.shuttingDown = true;
        
        const terminations = this.workers.map(async (workerInfo, index) => {
            if (workerInfo && workerInfo.worker) {
                try {
                    await workerInfo.worker.terminate();
                    console.log(`✅ Worker ${index} terminated`);
                } catch (error) {
                    console.error(`Error terminating worker ${index}:`, error);
                }
            }
        });
        
        return Promise.all(terminations);
    }
    
    async cleanup() {
        console.log('Cleaning up processing manager...');
        await this.terminateAllWorkers();
        if (this.db) {
            this.db.close();
        }
        this.stopMemoryLogging();
        console.log('Processing manager cleanup complete');
    }
}

// EXPORT SINGLETON INSTANCE
const instance = new ProcessingManager();
module.exports = instance;
