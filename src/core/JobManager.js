const EventEmitter = require('events');

class JobManager extends EventEmitter {
    constructor() {
        super();
        this.activeJob = null; // { id, type, startTime, progress: 0, status: 'idle', logs: [], stats: {} }
        this.history = [];
    }

    startJob(type, metadata = {}) {
        if (this.activeJob && this.activeJob.status === 'running') {
            throw new Error('A job is already running');
        }
        this.activeJob = {
            id: Date.now().toString(),
            type,
            status: 'running',
            progress: 0,
            message: 'Initializing...',
            logs: [],
            stats: { total: 0, processed: 0, success: 0, failed: 0 },
            metadata,
            startTime: Date.now()
        };
        this.emit('update', this.activeJob);
        return this.activeJob;
    }

    updateProgress(pct, message, logEntry = null) {
        if (!this.activeJob) return;
        this.activeJob.progress = pct;
        if (message) this.activeJob.message = message;
        if (logEntry) {
            this.activeJob.logs.push({ ts: Date.now(), text: logEntry });
            if (this.activeJob.logs.length > 100) this.activeJob.logs.shift(); // Keep memory sane
        }
        this.emit('update', this.activeJob);
    }

    updateStats(type) { // type: 'success' | 'fail'
        if (!this.activeJob) return;
        this.activeJob.stats.processed++;
        if (type === 'success') this.activeJob.stats.success++;
        if (type === 'fail') this.activeJob.stats.failed++;
        this.emit('update', this.activeJob);
    }

    completeJob(result = {}) {
        if (!this.activeJob) return;
        this.activeJob.status = 'completed';
        this.activeJob.progress = 100;
        this.activeJob.endTime = Date.now();
        this.activeJob.result = result;
        this.history.push(this.activeJob);
        this.emit('update', this.activeJob);
        // Keep activeJob populated so UI shows "Done" until user dismisses or starts new
    }

    clearJob() {
        this.activeJob = null;
        this.emit('cleared');
    }

    getState() {
        return this.activeJob;
    }
}

module.exports = new JobManager();
