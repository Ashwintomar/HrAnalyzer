// Controller for Candidate Analyzer Module

const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const processingManager = require('../../core/workerPool');
const AnalysisEngine = require('./analysisEngine');
const { loadPipeline } = require('../../core/pipelineManager');
const { getEmbeddingConfig, setEmbeddingConfig } = require('../../core/embeddingConfig');
const { setupDatabase } = require('../../databaseSetup');
const { Worker } = require('worker_threads');
const {
    WORKFLOW_TYPES,
    resolveWorkflowType,
    filterExportRows,
    calculateColumnWidths
} = require('./analyzerControllerUtils');
const { getDatabasePath, getResumesDir } = require('../../core/runtimePaths');

// Helper function to clean up temporary files
function cleanupFiles(filePaths) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) return;
    
    for (const filePath of filePaths) {
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log(`Cleaned up temporary file: ${filePath}`);
            }
        } catch (error) {
            console.warn(`Failed to delete temporary file ${filePath}:`, error.message);
        }
    }
}

// Initialize components in a factory function to pass `io`
module.exports = (io) => {
    let analysisEngine = null; // still used for ingestion-only path (candidate discovery)
    let rankingWorker = null;
    let rankingInProgress = false;

    // Helper to initialize services on demand
    async function ensureServicesInitialized() {
        // Ensure database is set up first
        try {
            await setupDatabase();
        } catch (error) {
            console.log('Database setup already completed or minor issue:', error.message);
        }
        
        await processingManager.initializeWorkers(path.join(__dirname, '../../workers/resumeProcessor.js'));
        if (!analysisEngine) {
            console.log('Initializing analysis engine for analyzer (ingest helper)...');
            analysisEngine = new AnalysisEngine();
        }
        if (!rankingWorker) {
            console.log('Spawning dedicated ranking worker...');
            rankingWorker = new Worker(path.join(__dirname, '../../workers/rankingWorker.js'));
            rankingWorker.on('message', (m) => {
                if (m.type === 'ready') {
                    console.log('Ranking worker ready');
                } else if (m.type === 'progress') {
                    // Mirror progress to server console for visibility in terminal
                    try { console.log(`[RankingWorker] ${m.status}`); } catch (_) { /* ignore */ }
                    io.emit('analyzer-progress', { percentage: 85, status: 'Ranking', message: m.status });
                } else if (m.type === 'complete') {
                    rankingInProgress = false;
                    // Log final completion details to server console as well
                    try {
                        const count = m?.result?.candidates ? m.result.candidates.length : 0;
                        console.log(`[RankingWorker] complete: success=${!!m.success} candidates=${count}`);
                    } catch (_) { /* ignore */ }
                    if (m.success) {
                        const rankingResult = m.result;
                        io.emit('analyzer-complete', {
                            success: true,
                            results: rankingResult.candidates,
                            jobId: rankingResult.jobId,
                            message: 'Ranking completed!',
                            stats: { total_processed: 0, total_failed: 0, total_ranked: rankingResult.candidates.length }
                        });
                    } else {
                        // Also log error to console for debugging
                        try { console.error('[RankingWorker] failed:', m.error); } catch (_) { /* ignore */ }
                        io.emit('analyzer-complete', { success: false, error: m.error });
                    }
                }
            });
            rankingWorker.on('error', err => {
                console.error('Ranking worker error:', err);
                rankingInProgress = false;
                io.emit('analyzer-complete', { success: false, error: err.message });
            });
            rankingWorker.on('exit', code => {
                console.log('Ranking worker exited with code', code);
                rankingWorker = null;
                rankingInProgress = false;
            });
        }
    }

    // Background processing function, now part of the controller
    async function processResumesInBackground(resumeData, jobData, options = {}) {
        const workflowType = resolveWorkflowType({
            resumeData,
            jobData,
            mode: options.mode
        });
        const embeddingConfig = options.embeddingConfig || (jobData ? jobData.embeddingConfig : getEmbeddingConfig());

        try {

            // Ingest-only workflow
            if (workflowType === WORKFLOW_TYPES.INGEST_ONLY) {
                console.log(`Starting background ingestion of ${resumeData.length} resumes using ${embeddingConfig.model} model...`);
                io.emit('analyzer-progress', { percentage: 0, status: 'Ingesting resumes...', message: `Starting ingestion of ${resumeData.length} candidates with ${embeddingConfig.model} model` });
                const results = await processingManager.submitTasks(resumeData, (progress) => {
                    const stats = progress.stats || { completed: 0, total: resumeData.length };
                    const pct = stats.total > 0 ? (stats.completed / stats.total) * 100 : 0;
                    io.emit('analyzer-progress', {
                        percentage: Math.min(100, Math.round(pct)),
                        status: 'Ingesting resumes...',
                        message: progress.message || `Processing candidate ${progress.candidateId || ''}`
                    });
                }, embeddingConfig, 'ANALYZER');
                
                // Store any extracted info from PDFs (would need to modify processResumes to return this)
                const extractedInfoMap = {};
                results.forEach(r => {
                    if (r.extractedInfo) {
                        // Could update candidate records with extracted info here
                        console.log(`Extracted info for candidate ${r.candidateId}:`, r.extractedInfo);
                    }
                });
                const successCount = results.filter(r => r.success).length;
                io.emit('analyzer-progress', { percentage: 100, status: 'Ingestion complete', message: `Processed ${successCount} resumes` });
                io.emit('analyzer-complete', {
                    success: true, results: [], message: `Ingestion complete! Added ${successCount} candidates.`,
                    stats: { total_processed: successCount, total_failed: results.length - successCount, total_ranked: 0 }
                });
                return;
            }

            // Rank-only workflow
            if (workflowType === WORKFLOW_TYPES.RANK_ONLY) {
                if (rankingInProgress) throw new Error('Ranking already in progress');
                console.log('Starting ranking of existing candidates (dedicated worker)...');
                rankingInProgress = true;
                io.emit('analyzer-progress', { percentage: 10, status: 'Queuing ranking job...', message: 'Dispatching ranking to worker' });
                // Display limit remains the cap for UI results
                const displayLimit = 50;
                // Compute fetchLimit based on reranker config when enabled (to allow reranking on more docs)
                let fetchLimit = displayLimit;
                try {
                    const rrCfg = jobData?.embeddingConfig?.reranker;
                    if (rrCfg && rrCfg.enabled) {
                        if (rrCfg.multi && Array.isArray(rrCfg.steps) && rrCfg.steps.length > 0) {
                            const maxTopN = rrCfg.steps
                                .map((s) => parseInt(s?.topN || 0, 10))
                                .reduce((a, b) => Math.max(a, b), 0);
                            fetchLimit = Math.max(displayLimit, Math.min(2000, maxTopN || displayLimit));
                        } else {
                            const n = parseInt(rrCfg?.topN || 0, 10);
                            fetchLimit = Math.max(displayLimit, Math.min(2000, n || displayLimit));
                        }
                    }
                } catch (_) { /* keep defaults */ }
                rankingWorker.postMessage({ type: 'rank', jobData, limit: displayLimit, fetchLimit, embeddingConfig });
                return;
            }

            // Ingest-and-rank workflow
            if (workflowType === WORKFLOW_TYPES.INGEST_AND_RANK) {
                console.log(`Starting background processing of ${resumeData.length} resumes...`);
                io.emit('analyzer-progress', { percentage: 0, status: 'Processing resumes...', message: `Starting analysis of ${resumeData.length} candidates` });
                const results = await processingManager.submitTasks(resumeData, (progress) => {
                    const stats = progress.stats || { completed: 0, total: resumeData.length };
                    // Cap resume processing portion at 80%
                    const pct = stats.total > 0 ? (stats.completed / stats.total) * 80 : 0;
                    io.emit('analyzer-progress', {
                        percentage: Math.min(80, Math.round(pct)),
                        status: 'Processing resumes...',
                        message: progress.message || `Processing candidate ${progress.candidateId || ''}`
                    });
                }, embeddingConfig, 'ANALYZER');
                
                // Store any extracted info from PDFs
                const extractedInfoMap = {};
                results.forEach(r => {
                    if (r.extractedInfo) {
                        // Could update candidate records with extracted info here
                        console.log(`Extracted info for candidate ${r.candidateId}:`, r.extractedInfo);
                    }
                });
                
                const successCount = results.filter(r => r.success).length;
                io.emit('analyzer-progress', { percentage: 80, status: 'Resume processing complete', message: `Processed ${successCount} resumes, starting job analysis` });
                if (successCount === 0) throw new Error('No resumes were processed successfully');

                io.emit('analyzer-progress', { percentage: 85, status: 'Queuing ranking...', message: 'Dispatching ranking to dedicated worker' });
                if (rankingInProgress) throw new Error('Ranking already in progress');
                rankingInProgress = true;
                // Display limit remains the cap for UI results
                const displayLimit = 50;
                // Compute fetchLimit based on reranker config when enabled (to allow reranking on more docs)
                let fetchLimit = displayLimit;
                try {
                    const rrCfg = jobData?.embeddingConfig?.reranker;
                    if (rrCfg && rrCfg.enabled) {
                        if (rrCfg.multi && Array.isArray(rrCfg.steps) && rrCfg.steps.length > 0) {
                            const maxTopN = rrCfg.steps
                                .map((s) => parseInt(s?.topN || 0, 10))
                                .reduce((a, b) => Math.max(a, b), 0);
                            fetchLimit = Math.max(displayLimit, Math.min(2000, maxTopN || displayLimit));
                        } else {
                            const n = parseInt(rrCfg?.topN || 0, 10);
                            fetchLimit = Math.max(displayLimit, Math.min(2000, n || displayLimit));
                        }
                    }
                } catch (_) { /* keep defaults */ }
                rankingWorker.postMessage({ type: 'rank', jobData, limit: displayLimit, fetchLimit, embeddingConfig });
                // Do not emit analyzer-complete here; ranking worker will emit when done
                return;
            }

            throw new Error('Invalid workflow parameters');

        } catch (error) {
            console.error('Background processing error:', error);
            io.emit('analyzer-complete', { success: false, error: error.message });
        }
    }

    // Function to recycle vectors by regenerating embeddings from local files.
    // This ensures ALL embeddings use the currently configured model.
    async function recycleVectorsInBackground() {
        try {
            const embeddingConfig = getEmbeddingConfig();
            console.log(`♻️ Starting vector recycling process with ${embeddingConfig.model} model...`);
            io.emit('analyzer-progress', { percentage: 0, status: 'Initializing recycling...', message: `Preparing to regenerate all embeddings with ${embeddingConfig.model} model` });

            // Use the unified pipeline manager which respects the current configuration
            const pipeline = await loadPipeline();
            
            if (!pipeline) {
                throw new Error('Failed to load AI pipeline');
            }

            // Clear ALL related data to ensure complete consistency
            console.log('Clearing existing vector data and job rankings...');
            io.emit('analyzer-progress', { percentage: 10, status: 'Clearing old data...', message: 'Removing all embeddings, jobs, and rankings for fresh start' });
            
            const db = analysisEngine.db;
            // Clear resume embeddings
            db.prepare('UPDATE Resumes SET embedding = NULL, embedding_json = NULL').run();
            // Clear all jobs and rankings to prevent dimension mismatches
            db.prepare('DELETE FROM Rankings').run();
            db.prepare('DELETE FROM Jobs').run();
            
            console.log('✅ Cleared all existing vector data and job records');

            // Fetch all resumes with a local file path from the database
            console.log('Querying database for local resume files...');
            io.emit('analyzer-progress', { percentage: 20, status: 'Querying DB...', message: 'Finding local resume files from database records' });
            const resumesToProcess = db.prepare(`
                SELECT id, candidate_id, local_file_path 
                FROM Resumes 
                WHERE local_file_path IS NOT NULL AND local_file_path != ''
            `).all();

            console.log(`Found ${resumesToProcess.length} resumes with local files to process.`);
            if (resumesToProcess.length === 0) {
                io.emit('analyzer-complete', { success: true, message: 'No local resumes found in the database to recycle.' });
                return;
            }

            // Process each file
            let processed = 0;
            const total = resumesToProcess.length;

            for (const resume of resumesToProcess) {
                try {
                    const { candidate_id: candidateId, local_file_path: filePath } = resume;
                    const fileName = path.basename(filePath);

                    if (!fs.existsSync(filePath)) {
                        console.warn(`Skipping candidate ${candidateId}: file not found at ${filePath}`);
                        continue;
                    }

                    console.log(`Processing ${fileName} for candidate ${candidateId} with current model...`);
                    
                    const progress = Math.round(20 + (processed / total) * 70);
                    io.emit('analyzer-progress', { 
                        percentage: progress, 
                        status: 'Regenerating embeddings...', 
                        message: `Processing ${fileName} with current model (${processed + 1}/${total})` 
                    });

                    // Read and parse PDF
                    const fileBuffer = fs.readFileSync(filePath);
                    const pdf = require('pdf-parse');
                    const pdfData = await pdf(fileBuffer);
                    let resumeText = pdfData.text || '';

                    // Clean and truncate text
                    resumeText = resumeText.replace(/\s+/g, ' ').trim();
                    const maxChars = 5000;
                    if (resumeText.length > maxChars) {
                        const head = resumeText.slice(0, Math.floor(maxChars * 0.7));
                        const tail = resumeText.slice(-Math.floor(maxChars * 0.3));
                        resumeText = head + '\n...\n' + tail;
                    }

                    if (resumeText.length < 5) {
                        resumeText = 'Empty resume content placeholder';
                    }

                    // Generate embedding using current model
                    const output = await pipeline([resumeText]);
                    const embedding = Array.isArray(output.data) ? output.data[0] : output.data;

                    // Update the existing resume record with new embedding and content
                    db.prepare(`
                        UPDATE Resumes 
                        SET content = ?, embedding = ?, embedding_json = ?, embedding_model = ?, processed_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                    `).run(resumeText, Buffer.from(embedding.buffer), JSON.stringify(Array.from(embedding)), embeddingConfig.model, resume.id);

                    processed++;

                } catch (fileError) {
                    const fileName = resume.local_file_path ? path.basename(resume.local_file_path) : `resume ID ${resume.id}`;
                    console.error(`Error processing ${fileName}:`, fileError);
                    continue;
                }
            }

            console.log(`Vector recycling completed! Processed ${processed}/${total} files with current model`);
            io.emit('analyzer-progress', { percentage: 100, status: 'Recycling complete', message: `Successfully regenerated ${processed} embeddings with current model` });
            io.emit('analyzer-complete', {
                success: true,
                results: [],
                message: `Vector recycling completed! Regenerated embeddings for ${processed} candidates using the currently loaded model. All jobs and rankings cleared for consistency.`,
                stats: { total_processed: processed, total_failed: total - processed, total_ranked: 0, model_used: 'current' }
            });

        } catch (error) {
            console.error('Vector recycling error:', error);
            io.emit('analyzer-complete', { success: false, error: error.message });
        }
    }

    // Helper function to reduce code duplication
    function _setModelConfiguration(selectedModel) {
        const validModels = ['bge-base-webgpu', 'bge-base-cpu', 'bge-small-cpu', 'gemini-online'];
        if (validModels.includes(selectedModel)) {
            let embeddingMode, embeddingModel, embeddingProvider;
            switch (selectedModel) {
                case 'bge-base-webgpu':
                case 'bge-base-cpu':
                    embeddingMode = 'local';
                    embeddingModel = 'bge-base';
                    embeddingProvider = 'local';
                    break;
                case 'bge-small-cpu':
                    embeddingMode = 'local';
                    embeddingModel = 'bge-small';
                    embeddingProvider = 'local';
                    break;
                case 'gemini-online':
                    embeddingMode = 'online';
                    embeddingModel = 'gemini-embedding-001';
                    embeddingProvider = 'gemini';
                    break;
            }
            setEmbeddingConfig({ mode: embeddingMode, model: embeddingModel, provider: embeddingProvider });
        }
    }

    return {
        // List jobs with pagination
        listJobs: async (req, res) => {
            try {
                await ensureServicesInitialized();
                const db = analysisEngine.db;
                const page = Math.max(1, parseInt(req.query.page || '1', 10));
                const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize || '10', 10)));
                const offset = (page - 1) * pageSize;
                const search = (req.query.search || '').trim();

                let where = '';
                let params = {};
                if (search) {
                    where = 'WHERE title LIKE @q OR description LIKE @q OR requirements LIKE @q';
                    params.q = `%${search}%`;
                }

                const totalRow = db.prepare(`SELECT COUNT(1) as cnt FROM Jobs ${where}`).get(params);
                const rows = db.prepare(`
                    SELECT j.id, j.title, j.created_at,
                           SUBSTR(COALESCE(j.description, ''), 1, 200) AS description_preview,
                           (SELECT COUNT(1) FROM Rankings r WHERE r.job_id = j.id) AS ranked_count,
                           ROUND((SELECT AVG(similarity_score) FROM Rankings r WHERE r.job_id = j.id), 4) AS avg_score
                    FROM Jobs j
                    ${where}
                    ORDER BY j.id DESC
                    LIMIT @limit OFFSET @offset
                `).all({ ...params, limit: pageSize, offset });

                res.json({
                    success: true,
                    page,
                    pageSize,
                    total: totalRow.cnt || 0,
                    jobs: rows
                });
            } catch (error) {
                console.error('List jobs error:', error);
                res.status(500).json({ success: false, error: error.message });
            }
        },

        // Get a job with top rankings and candidate details
        getJobDetails: async (req, res) => {
            try {
                await ensureServicesInitialized();
                const db = analysisEngine.db;
                const jobId = parseInt(req.params.id, 10);
                if (!jobId) return res.status(400).json({ success: false, error: 'Invalid job id' });
                const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));

                const job = db.prepare('SELECT id, title, description, requirements, created_at FROM Jobs WHERE id = ?').get(jobId);
                if (!job) return res.status(404).json({ success: false, error: 'Job not found' });

                // Get ranked candidates joined with latest resume content
                const rows = db.prepare(`
                    WITH latest_resumes AS (
                        SELECT r1.* FROM Resumes r1
                        JOIN (
                            SELECT candidate_id, MAX(id) AS max_id
                            FROM Resumes
                            GROUP BY candidate_id
                        ) mr ON r1.id = mr.max_id
                    )
                    SELECT 
                        rk.rank_position,
                        rk.similarity_score,
                        c.id AS candidate_id,
                        COALESCE(c.name, 'Candidate '||c.id) AS name,
                        c.email,
                        c.phone,
                        c.resume_url,
                        lr.content,
                        lr.local_file_path
                    FROM Rankings rk
                    JOIN Candidates c ON rk.candidate_id = c.id
                    LEFT JOIN latest_resumes lr ON lr.candidate_id = c.id
                    WHERE rk.job_id = @jobId
                    ORDER BY rk.rank_position ASC
                    LIMIT @limit
                `).all({ jobId, limit });

                const stats = db.prepare(`
                    SELECT COUNT(*) AS total_ranked,
                           AVG(similarity_score) AS avg_similarity,
                           MAX(similarity_score) AS max_similarity,
                           MIN(similarity_score) AS min_similarity
                    FROM Rankings
                    WHERE job_id = ?
                `).get(jobId);

                res.json({ success: true, job, results: rows, stats });
            } catch (error) {
                console.error('Get job details error:', error);
                res.status(500).json({ success: false, error: error.message });
            }
        },

        analyzeAndRank: async (req, res) => {
            // IMPORTANT: The form sends multipart/form-data, so body fields are strings.
            // We must parse the config object.
            try {
                const { jobTitle, keySkills, algorithm = 'cosine', minkowskiP, config } = req.body;
                const resumeFile = req.file;
                if (!resumeFile) return res.status(400).json({ success: false, error: 'No file uploaded' });
                if (!jobTitle || !keySkills) return res.status(400).json({ success: false, error: 'Role name and key skills are required' });
                if (!config) return res.status(400).json({ success: false, error: 'AI configuration is missing from the request.' });

                await ensureServicesInitialized();

                const workbook = xlsx.read(resumeFile.buffer, { type: 'buffer' });
                const sheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[sheetName];
                const data = xlsx.utils.sheet_to_json(worksheet);
                const resumeData = analysisEngine.findUniqueResumeUrls(data);
                const attempted = data.length;
                const unique = resumeData.length;
                const skipped = attempted - unique;

                if (resumeData.length === 0) {
                    return res.status(400).json({ success: false, error: `No valid resume URLs found. Available columns: ${Object.keys(data[0] || {}).join(', ')}` });
                }

                // Create job data object, now including the specific config for this task
                const parsedCfg = JSON.parse(config);
                const jobData = {
                    jobTitle,
                    keySkills,
                    algorithm,
                    embeddingConfig: parsedCfg, // includes embeddingConcurrency from frontend
                    ...(algorithm === 'minkowski' && minkowskiP && { minkowskiP: parseFloat(minkowskiP) })
                };

                res.json({ success: true, message: 'Analysis started', candidateCount: resumeData.length, duplicatesSkipped: skipped });
                processResumesInBackground(resumeData, jobData, { mode: WORKFLOW_TYPES.INGEST_AND_RANK });

            } catch (error) {
                console.error('Analysis error:', error);
                res.status(500).json({ success: false, error: error.message });
            }
        },

        ingestCandidates: async (req, res) => {
            try {
                const { config } = req.body; // Expect config for ingest-only as well
                const resumeFile = req.file;
                if (!resumeFile) return res.status(400).json({ success: false, error: 'No file uploaded' });
                if (!config) return res.status(400).json({ success: false, error: 'AI configuration is missing from the request.' });
                await ensureServicesInitialized();

                const workbook = xlsx.read(resumeFile.buffer, { type: 'buffer' });
                const sheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[sheetName];
                const data = xlsx.utils.sheet_to_json(worksheet);
                const resumeData = analysisEngine.findUniqueResumeUrls(data);
                const attempted = data.length;
                const unique = resumeData.length;
                const skipped = attempted - unique;

                if (resumeData.length === 0) return res.status(400).json({ success: false, error: 'No valid resume URLs found.' });

                res.json({ success: true, message: 'Ingestion started', candidateCount: resumeData.length, duplicatesSkipped: skipped });
                processResumesInBackground(resumeData, null, {
                    mode: WORKFLOW_TYPES.INGEST_ONLY,
                    embeddingConfig: JSON.parse(config)
                });

            } catch (error) {
                console.error('Ingestion error:', error);
                res.status(500).json({ success: false, error: error.message });
            }
        },

        bulkIngest: async (req, res) => {
            const uploadedFilePaths = []; // Track all uploaded files for cleanup
            try {
                const { config } = req.body;
                // Multer will provide req.files (array) - now stored on disk
                const files = req.files;
                if (!files || !files.length) {
                    return res.status(400).json({ success: false, error: 'No files uploaded. Expect field name "files" with one or more .pdf, .xlsx, .xls, or .csv files.' });
                }
                
                // Track all uploaded file paths for cleanup
                uploadedFilePaths.push(...files.map(f => f.path));

                if (!config) {
                    // Clean up uploaded files before returning error
                    cleanupFiles(uploadedFilePaths);
                    return res.status(400).json({ success: false, error: 'AI configuration is missing from the request.' });
                }
                
                await ensureServicesInitialized();
                const excelFiles = files.filter(f => /\.(xlsx|xls|csv)$/i.test(f.originalname));
                const pdfFiles = files.filter(f => /\.pdf$/i.test(f.originalname));
                if (!excelFiles.length && !pdfFiles.length) {
                    cleanupFiles(uploadedFilePaths);
                    return res.status(400).json({ success: false, error: 'Unsupported file types. Only PDF and Excel (.xlsx, .xls, .csv) are accepted.' });
                }
                let resumeData = [];
                let excelStatsAggregate = { files:0, attempted:0, inserted:0, duplicate_existing:0, duplicate_in_file:0, duplicate_across_files:0, invalid:0 };
                const globalCanonical = new Set();
                
                // Process Excel files - read from disk instead of buffer
                for (const ef of excelFiles) {
                    try {
                        const fileBuffer = fs.readFileSync(ef.path);
                        const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
                        const sheetName = workbook.SheetNames[0];
                        const worksheet = workbook.Sheets[sheetName];
                        const data = xlsx.utils.sheet_to_json(worksheet);
                        const { candidates, stats } = analysisEngine.findUniqueResumeUrlsWithStats(data);
                        excelStatsAggregate.files++;
                        excelStatsAggregate.attempted += stats.attempted;
                        excelStatsAggregate.inserted += stats.inserted;
                        excelStatsAggregate.duplicate_existing += stats.duplicate_existing;
                        excelStatsAggregate.duplicate_in_file += stats.duplicate_in_file;
                        excelStatsAggregate.invalid += stats.invalid;
                        // track across-file duplicates
                        for (const c of candidates) {
                            const ck = analysisEngine.canonicalizeResumeUrl(c.resumeUrl);
                            if (globalCanonical.has(ck)) {
                                excelStatsAggregate.duplicate_across_files++;
                                continue;
                            }
                            globalCanonical.add(ck);
                            resumeData.push(c);
                        }
                    } catch (e) {
                        console.warn('Excel parsing failed for', ef.originalname, e.message);
                    }
                }
                
                // Process PDF files in batches to avoid memory overload
                const resumesDir = getResumesDir();
                if (!fs.existsSync(resumesDir)) fs.mkdirSync(resumesDir, { recursive: true });
                const pdfCandidateEntries = [];
                let pdfDuplicates = 0;
                const BATCH_SIZE = 20; // Process 20 PDFs at a time
                
                for (let i = 0; i < pdfFiles.length; i += BATCH_SIZE) {
                    const batch = pdfFiles.slice(i, i + BATCH_SIZE);
                    console.log(`Processing PDF batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(pdfFiles.length/BATCH_SIZE)} (${batch.length} files)`);
                    
                    for (const pf of batch) {
                        try {
                            const safeName = pf.originalname.replace(/[^a-zA-Z0-9._-]/g,'_');
                            const destPath = path.join(resumesDir, `upload_${Date.now()}_${Math.random().toString(36).substring(7)}_${safeName}`);
                            
                            // Move file from temp upload to resumes directory
                            fs.renameSync(pf.path, destPath);
                            // Remove from uploadedFilePaths since it's been moved
                            const idx = uploadedFilePaths.indexOf(pf.path);
                            if (idx > -1) uploadedFilePaths.splice(idx, 1);
                            
                            const added = analysisEngine.addLocalPdfCandidate({ fileName: path.basename(destPath), localFilePath: destPath });
                            if (added.duplicate) {
                                pdfDuplicates++;
                                // Delete duplicate file
                                try { fs.unlinkSync(destPath); } catch (e) { console.warn('Failed to delete duplicate PDF:', e.message); }
                            } else {
                                pdfCandidateEntries.push({ candidateId: added.candidateId, resumeUrl: added.resumeUrl, name: added.name, email: null, phone: null, localFilePath: destPath });
                            }
                        } catch (e) {
                            console.warn('PDF processing failed for', pf.originalname, e.message);
                        }
                    }
                }
                
                // Clean up remaining temp Excel files
                cleanupFiles(uploadedFilePaths);
                
                const combined = [
                    ...resumeData,
                    ...pdfCandidateEntries.map(c => ({ candidateId: c.candidateId, resumeUrl: c.resumeUrl, name: c.name, localFilePath: c.localFilePath }))
                ];
                if (combined.length === 0) {
                    // Return success=false only if there was absolutely no attemptable data; if duplicates consumed everything, return success true with zero additions
                    const totalPotential = excelStatsAggregate.attempted + pdfFiles.length;
                    const duplicatesTotal = excelStatsAggregate.duplicate_existing + excelStatsAggregate.duplicate_in_file + excelStatsAggregate.duplicate_across_files + pdfDuplicates;
                    if (duplicatesTotal > 0 && totalPotential > 0) {
                        return res.json({
                            success: true,
                            message: 'All provided entries were duplicates. No new candidates added.',
                            candidateCount: 0,
                            stats: { excel: excelStatsAggregate, pdf_added: 0, pdf_duplicates: pdfDuplicates }
                        });
                    }
                    const debugInfo = {
                        totalUploaded: files.length,
                        excelFiles: excelFiles.map(f => f.originalname),
                        pdfFiles: pdfFiles.map(f => f.originalname),
                        reason: 'Parsed 0 resume entries from Excel and 0 unique PDFs'
                    };
                    return res.status(400).json({ success: false, error: 'No valid resumes found in provided files. Ensure Excel has a column with resume URLs (e.g. resume_url, url, link) or include PDF files.', debug: debugInfo });
                }
                res.json({ 
                    success: true, 
                    message: `Bulk ingestion queued for ${combined.length} candidates using current model`, 
                    candidateCount: combined.length, 
                    pdfCount: pdfCandidateEntries.length, 
                    urlCount: resumeData.length, 
                    stats: { excel: excelStatsAggregate, pdf_added: pdfCandidateEntries.length, pdf_duplicates: pdfDuplicates } 
                });
                processResumesInBackground(combined, null, {
                    mode: WORKFLOW_TYPES.INGEST_ONLY,
                    embeddingConfig: JSON.parse(config)
                });
            } catch (error) {
                console.error('Bulk ingestion error:', error);
                // Clean up any uploaded files on error
                cleanupFiles(uploadedFilePaths);
                res.status(500).json({ success: false, error: error.message });
            }
        },

        // New: Bulk Excel-only ingestion with robust duplicate metrics
        bulkExcelIngest: async (req, res) => {
            const uploadedFilePaths = []; // Track all uploaded files for cleanup
            try {
                const files = req.files;
                if (!files || !files.length) return res.status(400).json({ success: false, error: 'No Excel files uploaded' });
                
                // Track all uploaded file paths for cleanup
                uploadedFilePaths.push(...files.map(f => f.path));
                
                await ensureServicesInitialized();
                const excelFiles = files.filter(f => /\.(xlsx|xls|csv)$/i.test(f.originalname));
                if (!excelFiles.length) {
                    cleanupFiles(uploadedFilePaths);
                    return res.status(400).json({ success: false, error: 'No valid Excel files provided (.xlsx, .xls, .csv)' });
                }

                let aggregateCandidates = [];
                const aggregateStats = { files: 0, attempted: 0, inserted: 0, duplicate_existing: 0, duplicate_in_file: 0, duplicate_across_files: 0, invalid: 0 };
                const globalCanonicalSeen = new Set();

                for (const ef of excelFiles) {
                    try {
                        // Read from disk instead of buffer
                        const fileBuffer = fs.readFileSync(ef.path);
                        const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
                        const sheetName = workbook.SheetNames[0];
                        const worksheet = workbook.Sheets[sheetName];
                        const data = xlsx.utils.sheet_to_json(worksheet);
                        const { candidates, stats } = analysisEngine.findUniqueResumeUrlsWithStats(data);
                        aggregateStats.files++;
                        aggregateStats.attempted += stats.attempted;
                        aggregateStats.inserted += stats.inserted;
                        aggregateStats.duplicate_existing += stats.duplicate_existing;
                        aggregateStats.duplicate_in_file += stats.duplicate_in_file;
                        aggregateStats.invalid += stats.invalid;
                        // Detect cross-file duplicates by canonical key of already added candidates
                        for (const c of candidates) {
                            const ck = analysisEngine.canonicalizeResumeUrl(c.resumeUrl);
                            if (globalCanonicalSeen.has(ck)) {
                                aggregateStats.duplicate_across_files++;
                                continue; // skip adding duplicate across different excel files
                            }
                            globalCanonicalSeen.add(ck);
                            aggregateCandidates.push(c);
                        }
                    } catch (e) {
                        console.warn('Excel parsing failed for', ef.originalname, e.message);
                    }
                }
                
                // Clean up Excel temp files
                cleanupFiles(uploadedFilePaths);

                if (!aggregateCandidates.length) {
                    return res.status(400).json({
                        success: false,
                        error: 'No new unique resume URLs found after duplicate filtering',
                        stats: aggregateStats
                    });
                }

                res.json({
                    success: true,
                    message: `Bulk Excel ingestion queued for ${aggregateCandidates.length} candidates`,
                    candidateCount: aggregateCandidates.length,
                    stats: aggregateStats
                });
                processResumesInBackground(aggregateCandidates, null, {
                    mode: WORKFLOW_TYPES.INGEST_ONLY
                });
            } catch (error) {
                console.error('Bulk Excel ingestion error:', error);
                // Clean up any uploaded files on error
                cleanupFiles(uploadedFilePaths);
                res.status(500).json({ success: false, error: error.message });
            }
        },

        rankExisting: async (req, res) => {
            try {
                const { jobTitle, keySkills, algorithm = 'cosine', minkowskiP, config } = req.body;
                if (!jobTitle || !keySkills) return res.status(400).json({ success: false, error: 'Role name and key skills are required' });

                await ensureServicesInitialized();

                // Create job data object, now including the specific config for this task
                const jobData = {
                    jobTitle,
                    keySkills,
                    algorithm,
                    embeddingConfig: config, // Already an object for JSON requests
                    ...(algorithm === 'minkowski' && minkowskiP && { minkowskiP: parseFloat(minkowskiP) })
                };

                res.json({ success: true, message: 'Ranking of existing candidates started.' });
                processResumesInBackground(null, jobData, { mode: WORKFLOW_TYPES.RANK_ONLY });

            } catch (error) {
                console.error('Ranking error:', error);
                res.status(500).json({ success: false, error: error.message });
            }
        },

    exportResults: async (req, res) => {
            try {
        // Expect either jobId to regenerate latest ranking or raw results fallback
        // Optional exportFormat: xlsx (default) | pdf
        const {
            jobId,
            limit = 50,
            results,
            exportFormat = 'xlsx',
            excludeHighScores = false,
            thresholdPercent
        } = req.body || {};
                console.log('[Export] Request params:', { jobId, limit, resultsLength: results?.length, exportFormat, excludeHighScores, thresholdPercent });
                let exportRows = [];
                let jobMeta = null;
                let rankingStats = null;

                if (jobId) {
                    // Fetch rankings for the job (ordered)
                    const db = analysisEngine ? analysisEngine.db : new Database(getDatabasePath());
                    // Build export rows: Rankings joined to candidate info and the latest resume content/file
                    // Note: resume_url lives on Candidates table (not Resumes). We select latest resume per candidate
                    const stmt = db.prepare(`
                        WITH latest_resumes AS (
                            SELECT r1.* FROM Resumes r1
                            JOIN (
                                SELECT candidate_id, MAX(id) AS max_id
                                FROM Resumes
                                GROUP BY candidate_id
                            ) mr ON r1.id = mr.max_id
                        )
                        SELECT 
                            rk.rank_position AS rank_position,
                            rk.similarity_score AS similarity_score,
                            c.id AS candidate_id,
                            c.name AS name,
                            c.email AS email,
                            c.phone AS phone,
                            c.resume_url AS resume_url,
                            lr.content AS content,
                            lr.local_file_path AS local_file_path
                        FROM Rankings rk
                        JOIN Candidates c ON rk.candidate_id = c.id
                        LEFT JOIN latest_resumes lr ON lr.candidate_id = c.id
                        WHERE rk.job_id = ?
                        ORDER BY rk.rank_position ASC
                        LIMIT ?
                    `);
                    exportRows = stmt.all(jobId, limit);
                    console.log('[Export] Database query returned:', exportRows.length, 'rows');
                    console.log('[Export] First few rows:', JSON.stringify(exportRows.slice(0, 2), null, 2));
                    // Gather job meta + stats for supplemental sheets
                    try {
                        jobMeta = db.prepare(`SELECT id, title, description, requirements, created_at FROM Jobs WHERE id = ?`).get(jobId);
                        rankingStats = db.prepare(`
                            SELECT COUNT(*) AS total_ranked,
                                   AVG(similarity_score) AS avg_similarity,
                                   MAX(similarity_score) AS max_similarity,
                                   MIN(similarity_score) AS min_similarity
                            FROM Rankings
                            WHERE job_id = ?
                        `).get(jobId);
                    } catch (metaErr) {
                        console.warn('[Export] Failed to load job metadata/stats:', metaErr.message);
                    }
                    console.log(`[Export] Retrieved ${exportRows.length} rows for jobId ${jobId}`);
                } else if (Array.isArray(results)) {
                    exportRows = results.slice(0, limit).map((r, i) => ({
                        rank_position: r.rank_position || i + 1,
                        similarity_score: r.similarity_score,
                        candidate_id: r.candidate_id,
                        name: r.name,
                        email: r.email,
                        phone: r.phone,
                        content: r.content,
                        resume_url: r.resume_url,
                        local_file_path: r.local_file_path
                    }));
                } else {
                    return res.status(400).json({ success: false, error: 'jobId or results array required' });
                }

                exportRows = filterExportRows(exportRows, { excludeHighScores, thresholdPercent });

                if (exportRows.length === 0) {
                    console.log('[Export] ERROR: No rows to export');
                    return res.status(400).json({ success: false, error: 'No rows to export' });
                }

                if (exportFormat === 'pdf') {
                    const PDFDocument = require('pdfkit');
                    const doc = new PDFDocument({ margin: 30, size: 'A4' });
                    res.setHeader('Content-Type', 'application/pdf');
                    res.setHeader('Content-Disposition', 'attachment; filename=hr_analyzer_rankings.pdf');
                    doc.pipe(res);

                    // Title and metadata
                    doc.fontSize(20).fillColor('#1a202c').text('Candidate Rankings Report', { align: 'center' });
                    doc.fontSize(10).fillColor('#64748b').text(`Generated on ${new Date().toLocaleDateString()}`, { align: 'center' });
                    doc.moveDown(1);

                    // Calculate optimal column widths using full page width
                    const pageWidth = doc.page.width - (doc.page.margins.left + doc.page.margins.right);
                    const startX = doc.page.margins.left;
                    
                    // Optimized column layout for better space utilization
                    const colDefs = [
                        { key: 'rank', title: 'Rank', width: Math.floor(pageWidth * 0.08) }, // 8% - wider for better spacing
                        { key: 'candidate', title: 'Candidate Name', width: Math.floor(pageWidth * 0.25) }, // 25%
                        { key: 'score', title: 'Score', width: Math.floor(pageWidth * 0.10) }, // 10%
                        { key: 'email', title: 'Email Address', width: Math.floor(pageWidth * 0.35) }, // 35% - much wider for emails
                        { key: 'phone', title: 'Phone', width: Math.floor(pageWidth * 0.15) }, // 15%
                        { key: 'url', title: 'Resume', width: Math.floor(pageWidth * 0.07) } // 7%
                    ];
                    
                    const tableWidth = colDefs.reduce((a,c)=>a+c.width,0);
                    let y = doc.y + 8;
                    const headerH = 22;

                    // Modern header design with better styling
                    doc.save();
                    doc.roundedRect(startX-3, y-3, tableWidth+6, headerH+6, 6)
                       .fillAndStroke('#f1f5f9', '#e2e8f0');
                    doc.restore();
                    
                    doc.fontSize(9).fillColor('#334155').font('Helvetica-Bold');
                    let cursorX = startX;
                    colDefs.forEach(col => {
                        doc.text(col.title, cursorX+6, y+6, { 
                            width: col.width-12, 
                            align: col.key === 'rank' || col.key === 'score' ? 'center' : 'left',
                            ellipsis: true
                        });
                        cursorX += col.width;
                    });
                    y += headerH + 4;
                    
                    // Header bottom border
                    doc.moveTo(startX-3, y-2).lineTo(startX+tableWidth+3, y-2)
                       .strokeColor('#cbd5e1').lineWidth(1.5).stroke();

                    const baseRowH = 18; // Base height, will be dynamic
                    let rowCount = 0;
                    
                    exportRows.forEach(r => {
                        const rank = r.rank_position;
                        const candidate = r.name || `Candidate ${r.candidate_id}`;
                        const score = r.similarity_score != null ? (r.similarity_score * 100).toFixed(1) + '%' : '';
                        const email = r.email || '';
                        const phone = r.phone || '';
                        const urlVal = r.resume_url || '';

                        // Calculate dynamic row height based on content
                        const emailLines = email.length > 40 ? Math.ceil(email.length / 40) : 1;
                        const candidateLines = candidate.length > 30 ? Math.ceil(candidate.length / 30) : 1;
                        const maxLines = Math.max(emailLines, candidateLines, 1);
                        const rowH = Math.max(baseRowH, maxLines * 12 + 8);

                        // Page break check with new row height
                        if (y + rowH + 10 > doc.page.height - doc.page.margins.bottom) {
                            doc.addPage();
                            y = doc.y + 20;
                            // Redraw header on new page
                            doc.save();
                            doc.roundedRect(startX-3, y-3, tableWidth+6, headerH+6, 6)
                               .fillAndStroke('#f1f5f9', '#e2e8f0');
                            doc.restore();
                            doc.fontSize(9).fillColor('#334155').font('Helvetica-Bold');
                            cursorX = startX;
                            colDefs.forEach(col => { 
                                doc.text(col.title, cursorX+6, y+6, { 
                                    width: col.width-12,
                                    align: col.key === 'rank' || col.key === 'score' ? 'center' : 'left',
                                    ellipsis: true
                                }); 
                                cursorX += col.width; 
                            });
                            y += headerH + 4;
                            doc.moveTo(startX-3, y-2).lineTo(startX+tableWidth+3, y-2)
                               .strokeColor('#cbd5e1').lineWidth(1.5).stroke();
                        }

                        // Alternating row background for better readability
                        if (rowCount % 2 === 0) {
                            doc.save();
                            doc.rect(startX-3, y-2, tableWidth+6, rowH+2).fill('#f8fafc');
                            doc.restore();
                        }
                        
                        cursorX = startX;
                        doc.font('Helvetica').fontSize(8.5).fillColor('#1e293b');
                        
                        const cells = [
                            { value: rank, align: 'center' },
                            { value: candidate, align: 'left' },
                            { value: score, align: 'center' },
                            { value: email, align: 'left' },
                            { value: phone, align: 'left' },
                            { value: (urlVal ? 'View' : ''), align: 'center', isUrl: !!urlVal, url: urlVal }
                        ];
                        
                        cells.forEach((cell, idx) => {
                            const col = colDefs[idx];
                            const options = { 
                                width: col.width-12, 
                                align: cell.align,
                                ellipsis: true,
                                lineBreak: cell.value.length > 40 // Allow line breaks for long content
                            };
                            
                            if (cell.isUrl && cell.url) {
                                // Style URL links better
                                if (/^https?:\/\//i.test(cell.url)) {
                                    doc.fillColor('#2563eb').font('Helvetica-Bold')
                                       .text('View', cursorX+6, y+4, { ...options, link: cell.url, underline: true });
                                } else {
                                    doc.fillColor('#64748b').font('Helvetica')
                                       .text('File', cursorX+6, y+4, options);
                                }
                            } else {
                                // Handle different text colors for different columns
                                let textColor = '#1e293b';
                                if (idx === 0 || idx === 2) textColor = '#0f172a'; // Rank and score - darker
                                if (idx === 3) textColor = '#1d4ed8'; // Email - blue
                                if (idx === 4) textColor = '#059669'; // Phone - green
                                
                                doc.fillColor(textColor).font('Helvetica')
                                   .text(String(cell.value || ''), cursorX+6, y+4, options);
                            }
                            cursorX += col.width;
                        });
                        
                        // Row separator with subtle styling
                        y += rowH;
                        doc.moveTo(startX-1, y-1).lineTo(startX+tableWidth+1, y-1)
                           .strokeColor('#e2e8f0').lineWidth(0.5).stroke();
                        
                        rowCount++;
                    });

                    // Footer with summary
                    doc.fontSize(8).fillColor('#64748b')
                       .text(`Total candidates ranked: ${exportRows.length}`, startX, y + 20, { align: 'left' })
                        .text('Hr Analyzer - Submission Demo', startX, y + 20, { align: 'right' });

                    doc.end();
                    return;
                }

                // Enhanced Excel data preparation with better debugging
                console.log(`[Export] Processing ${exportRows.length} export rows for Excel...`);
                
                let prettyData = exportRows.map((row, idx) => {
                    console.log(`[Export] Row ${idx + 1}:`, {
                        rank: row.rank_position,
                        name: row.name,
                        email: row.email,
                        phone: row.phone,
                        similarity: row.similarity_score
                    });
                    
                    return {
                        Rank: row.rank_position || (idx + 1),
                        CandidateID: row.candidate_id || 'Unknown',
                        Name: row.name || `Candidate ${row.candidate_id || idx + 1}`,
                        Similarity: (row.similarity_score != null ? (row.similarity_score * 100).toFixed(2) + '%' : 'N/A'),
                        Email: row.email || 'Not provided',
                        Phone: row.phone || 'Not provided',
                        ResumeURL: row.resume_url || 'No URL',
                        LocalFile: row.local_file_path || 'No file',
                        Preview: row.content ? row.content.substring(0, 400).replace(/\s+/g, ' ') : 'No preview available'
                    };
                });

                console.log(`[Export] Generated ${prettyData.length} pretty data rows`);
                console.log(`[Export] Sample row:`, prettyData[0]);

                // Ensure we always have data for the main sheet
                if (prettyData.length === 0) {
                    console.warn('[Export] No data available - creating placeholder row');
                    prettyData = [{
                        Rank: 1,
                        CandidateID: 'No data',
                        Name: 'No candidates ranked yet. Please run analysis first.',
                        Similarity: 'N/A',
                        Email: 'N/A',
                        Phone: 'N/A',
                        ResumeURL: 'N/A',
                        LocalFile: 'N/A',
                        Preview: 'Please ensure candidates have been analyzed and ranked before exporting.'
                    }];
                }

                const workbook = xlsx.utils.book_new();
                
                console.log(`[Export] Creating main Resumes sheet with ${prettyData.length} rows`);
                console.log(`[Export] Headers:`, Object.keys(prettyData[0]));
                
                // Create the main sheet with proper formatting
                const worksheet = xlsx.utils.json_to_sheet(prettyData, { 
                    header: Object.keys(prettyData[0]),
                    skipHeader: false
                });

                // Enhanced auto width calculation
                const headers = Object.keys(prettyData[0]);
                const colWidths = calculateColumnWidths(prettyData, headers, { maxWidth: 60, padding: 2 });
                worksheet['!cols'] = colWidths;

                // Freeze header row
                worksheet['!freeze'] = { xSplit: 0, ySplit: 1 };

                // Enhanced header styling
                headers.forEach((header, idx) => {
                    const cellRef = xlsx.utils.encode_cell({ r: 0, c: idx });
                    if (worksheet[cellRef]) {
                        worksheet[cellRef].s = { 
                            font: { bold: true, color: { rgb: "FFFFFF" } },
                            fill: { fgColor: { rgb: "366092" } },
                            alignment: { horizontal: "center" }
                        };
                    }
                });

                xlsx.utils.book_append_sheet(workbook, worksheet, 'Resumes');
                console.log('[Export] Main Resumes sheet created successfully');

                // Add enhanced RawData sheet with complete information
                if (exportRows.length > 0) {
                    console.log(`[Export] Creating RawData sheet with ${exportRows.length} rows`);
                    
                    const rawRows = exportRows.map((r, idx) => ({
                        rank_position: r.rank_position || (idx + 1),
                        similarity_score: r.similarity_score || 0,
                        candidate_id: r.candidate_id || `unknown_${idx + 1}`,
                        name: r.name || `Candidate ${r.candidate_id || idx + 1}`,
                        email: r.email || 'Not provided',
                        phone: r.phone || 'Not provided',
                        resume_url: r.resume_url || 'No URL available',
                        local_file_path: r.local_file_path || 'No local file',
                        content_preview: (r.content || '').substring(0, 5000) || 'No content available'
                    }));
                    
                    const rawSheet = xlsx.utils.json_to_sheet(rawRows);
                    
                    // Auto-size columns for raw data
                    const rawColWidths = calculateColumnWidths(rawRows, Object.keys(rawRows[0]), { maxWidth: 50, padding: 2 });
                    rawSheet['!cols'] = rawColWidths;
                    
                    // Style the headers
                    Object.keys(rawRows[0]).forEach((header, idx) => {
                        const cellRef = xlsx.utils.encode_cell({ r: 0, c: idx });
                        if (rawSheet[cellRef]) {
                            rawSheet[cellRef].s = { font: { bold: true } };
                        }
                    });
                    
                    xlsx.utils.book_append_sheet(workbook, rawSheet, 'RawData');
                    console.log('[Export] RawData sheet created successfully');
                } else {
                    console.log('[Export] No data available for RawData sheet');
                }

                // Add JobMeta sheet when job metadata available
                console.log(`[Export] JobMeta:`, jobMeta);
                console.log(`[Export] RankingStats:`, rankingStats);
                
                if (jobMeta || rankingStats) {
                    const metaRows = [];
                    
                    if (jobMeta) {
                        metaRows.push({ Key: 'Job ID', Value: jobMeta.id || 'Unknown' });
                        metaRows.push({ Key: 'Title', Value: jobMeta.title || 'Untitled Job' });
                        metaRows.push({ Key: 'Created At', Value: jobMeta.created_at || 'Unknown' });
                        
                        // Store description & requirements (truncate to keep sheet manageable)
                        const desc = (jobMeta.description || 'No description provided').substring(0, 12000);
                        const reqs = (jobMeta.requirements || 'No requirements specified').substring(0, 12000);
                        metaRows.push({ Key: 'Description', Value: desc });
                        metaRows.push({ Key: 'Requirements', Value: reqs });
                    }
                    
                    if (rankingStats) {
                        metaRows.push({ Key: 'Total Ranked', Value: rankingStats.total_ranked || 0 });
                        metaRows.push({ Key: 'Avg Similarity', Value: rankingStats.avg_similarity != null ? (rankingStats.avg_similarity * 100).toFixed(2) + '%' : 'N/A' });
                        metaRows.push({ Key: 'Max Similarity', Value: rankingStats.max_similarity != null ? (rankingStats.max_similarity * 100).toFixed(2) + '%' : 'N/A' });
                        metaRows.push({ Key: 'Min Similarity', Value: rankingStats.min_similarity != null ? (rankingStats.min_similarity * 100).toFixed(2) + '%' : 'N/A' });
                    }
                    
                    // Add export info
                    metaRows.push({ Key: 'Export Date', Value: new Date().toISOString() });
                    metaRows.push({ Key: 'Export Count', Value: exportRows.length });
                    
                    console.log(`[Export] Creating JobMeta sheet with ${metaRows.length} rows`);
                    
                    if (metaRows.length > 0) {
                        const metaSheet = xlsx.utils.json_to_sheet(metaRows);
                        // Autosize meta columns
                        const metaColWidths = calculateColumnWidths(metaRows, ['Key', 'Value'], { maxWidth: 80, padding: 2 });
                        metaSheet['!cols'] = metaColWidths;
                        
                        // Style the headers
                        ['A1', 'B1'].forEach(cellRef => {
                            if (metaSheet[cellRef]) {
                                metaSheet[cellRef].s = { font: { bold: true } };
                            }
                        });
                        
                        xlsx.utils.book_append_sheet(workbook, metaSheet, 'JobMeta');
                    }
                } else {
                    console.log('[Export] No job metadata available for JobMeta sheet');
                }
                const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
                console.log('[Export] Generated Excel buffer size:', buffer.length, 'bytes');

                res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
                res.setHeader('Content-Disposition', 'attachment; filename=hr_analyzer_rankings.xlsx');
                res.send(buffer);

            } catch (error) {
                console.error('Export error:', error);
                res.status(500).json({ success: false, error: error.message });
            }
        },

        viewResume: (req, res) => {
            const filePath = req.query.path;
            if (!filePath) return res.status(400).json({ error: 'File path required' });

            const decodedPath = decodeURIComponent(filePath);
            const resumesDir = getResumesDir();
            const fileName = path.basename(decodedPath);
            const fullPath = path.join(resumesDir, fileName);
            const resolvedFullPath = path.resolve(fullPath);
            const resolvedResumesDir = path.resolve(resumesDir);

            if (!resolvedFullPath.startsWith(resolvedResumesDir)) {
                return res.status(403).json({ error: 'Access denied' });
            }
            if (!fs.existsSync(resolvedFullPath)) {
                return res.status(404).json({ error: 'File not found' });
            }

            res.download(resolvedFullPath);
        },

        recycleVectors: async (req, res) => {
            try {
                await ensureServicesInitialized();
                res.json({ 
                    success: true, 
                    message: `Vector recycling started with current model.`
                });
                
                // Start the recycling process in background
                recycleVectorsInBackground();

            } catch (error) {
                console.error('Recycle vectors error:', error);
                res.status(500).json({ success: false, error: error.message });
            }
        },

        // Drop all jobs and rankings
        dropAllJobs: async (req, res) => {
            try {
                await ensureServicesInitialized();
                const db = analysisEngine.db;

                // Delete all rankings first (due to foreign key constraint)
                const rankingsResult = db.prepare('DELETE FROM Rankings').run();
                // Delete all jobs
                const jobsResult = db.prepare('DELETE FROM Jobs').run();

                console.log(`✅ Dropped ${jobsResult.changes} jobs and ${rankingsResult.changes} rankings`);

                res.json({ 
                    success: true, 
                    message: `Successfully dropped ${jobsResult.changes} jobs and ${rankingsResult.changes} rankings`,
                    jobsDeleted: jobsResult.changes,
                    rankingsDeleted: rankingsResult.changes
                });

            } catch (error) {
                console.error('Drop all jobs error:', error);
                res.status(500).json({ success: false, error: error.message });
            }
        },

        shutdownModule: (req, res) => {
            console.log('Shutdown requested for analyzer module...');
            if (analysisEngine) analysisEngine.close();
            if (rankingWorker) { try { rankingWorker.terminate(); } catch (e) { /* ignore */ } rankingWorker = null; }
            analysisEngine = null;
            res.json({ message: 'Analyzer module resources released.' });
        }
    };
};
