class ProcessingRunState {
    constructor({ onReset = () => {}, schedule = setTimeout, clearSchedule = clearTimeout } = {}) {
        this.onReset = onReset;
        this.schedule = schedule;
        this.clearSchedule = clearSchedule;
        this.nextRunId = 0;
        this.latestRunId = null;
        this.runs = new Map();
        this.resetHandle = null;
    }

    startRun({ jobType, total }) {
        this.clearReset();

        const id = ++this.nextRunId;
        const run = {
            id,
            jobType,
            total: Math.max(0, Number(total) || 0),
            completed: 0,
            startTime: Date.now()
        };

        this.runs.set(id, run);
        this.latestRunId = id;
        return this.getSnapshot(id);
    }

    markCompleted(runId) {
        const run = this.runs.get(runId);
        if (!run) return null;

        run.completed = Math.min(run.total, run.completed + 1);
        return this.getSnapshot(runId);
    }

    getSnapshot(runId) {
        const run = this.runs.get(runId);
        if (!run) return null;

        return {
            id: run.id,
            jobType: run.jobType,
            total: run.total,
            completed: run.completed,
            remaining: Math.max(0, run.total - run.completed),
            progress: run.total > 0 ? Math.round((run.completed / run.total) * 100) : 0,
            startTime: run.startTime
        };
    }

    getLatestSnapshot() {
        if (!this.latestRunId) return null;
        return this.getSnapshot(this.latestRunId);
    }

    clearReset() {
        if (this.resetHandle) {
            this.clearSchedule(this.resetHandle);
            this.resetHandle = null;
        }
    }

    scheduleReset(runId, delayMs = 5000, isIdle = () => true) {
        this.clearReset();

        const attemptReset = () => {
            if (this.latestRunId !== runId) {
                this.resetHandle = null;
                return;
            }

            if (!isIdle()) {
                this.resetHandle = this.schedule(attemptReset, delayMs);
                return;
            }

            this.runs.delete(runId);
            this.resetHandle = null;
            this.onReset();
        };

        this.resetHandle = this.schedule(attemptReset, delayMs);
        return this.resetHandle;
    }
}

module.exports = {
    ProcessingRunState
};
