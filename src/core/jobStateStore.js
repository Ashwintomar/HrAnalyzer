const path = require('path');
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');
const { ensureRuntimeDirectories, getDatabasePath } = require('./runtimePaths');

const DEFAULT_DB_PATH = process.env.JOB_STATE_DB_PATH
    ? path.resolve(process.env.JOB_STATE_DB_PATH)
    : getDatabasePath();

/**
 * Centralized persistence for long-running job state so clients can reload and recover progress.
 */
class JobStateStore {
    constructor(dbPath = DEFAULT_DB_PATH) {
        ensureRuntimeDirectories();
        this.dbPath = dbPath;
        this.db = new Database(this.dbPath);
        this._ensureSchema();

        this.insertStmt = this.db.prepare(`
            INSERT INTO JobRuns (
                id, type, label, status, stage, message, progress,
                stats_json, metadata_json, logs_json, socket_id
            ) VALUES (
                @id, @type, @label, @status, @stage, @message, @progress,
                @stats_json, @metadata_json, @logs_json, @socket_id
            )
        `);

        this.updateStmt = this.db.prepare(`
            UPDATE JobRuns SET
                status = COALESCE(@status, status),
                stage = COALESCE(@stage, stage),
                message = COALESCE(@message, message),
                progress = COALESCE(@progress, progress),
                stats_json = CASE WHEN @stats_json IS NULL THEN stats_json ELSE @stats_json END,
                metadata_json = CASE WHEN @metadata_json IS NULL THEN metadata_json ELSE @metadata_json END,
                socket_id = COALESCE(@socket_id, socket_id),
                error_message = COALESCE(@error_message, error_message),
                updated_at = CURRENT_TIMESTAMP,
                completed_at = COALESCE(@completed_at, completed_at)
            WHERE id = @id
        `);

        this.appendLogStmt = this.db.prepare(`
            UPDATE JobRuns
            SET logs_json = @logs_json,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = @id
        `);
    }

    close() {
        if (this.db?.open) {
            this.db.close();
        }
    }

    createJob({ type, label, socketId = null, metadata = {} }) {
        if (!type) throw new Error('type is required to create a job');
        const id = randomUUID();
        const payload = {
            id,
            type,
            label: label || null,
            status: 'pending',
            stage: 'queued',
            message: 'Waiting to start',
            progress: 0,
            stats_json: JSON.stringify({}),
            metadata_json: JSON.stringify(metadata || {}),
            logs_json: JSON.stringify([]),
            socket_id: socketId || null
        };
        this.insertStmt.run(payload);
        return this.getJob(id);
    }

    updateJob(id, patch = {}) {
        if (!id) return null;
        const current = this.getJob(id);
        if (!current) return null;

        const stats = patch.stats
            ? JSON.stringify({ ...current.stats, ...patch.stats })
            : null;
        const metadata = patch.metadata
            ? JSON.stringify({ ...current.metadata, ...patch.metadata })
            : null;

        this.updateStmt.run({
            id,
            status: patch.status,
            stage: patch.stage,
            message: patch.message,
            progress: typeof patch.progress === 'number' ? patch.progress : null,
            stats_json: stats,
            metadata_json: metadata,
            socket_id: patch.socketId,
            error_message: patch.error,
            completed_at: patch.completed ? new Date().toISOString() : null
        });
        return this.getJob(id);
    }

    appendLog(id, entry) {
        if (!id || !entry) return null;
        const current = this.getJob(id);
        if (!current) return null;
        const logs = Array.isArray(current.logs) ? [...current.logs] : [];
        logs.push({ ts: Date.now(), ...entry });
        const trimmed = logs.slice(-100);
        this.appendLogStmt.run({ id, logs_json: JSON.stringify(trimmed) });
        return trimmed;
    }

    completeJob(id, payload = {}) {
        return this.updateJob(id, {
            status: payload.status || 'completed',
            stage: payload.stage || 'complete',
            message: payload.message || 'Done',
            progress: typeof payload.progress === 'number' ? payload.progress : 100,
            stats: payload.stats,
            metadata: payload.metadata,
            completed: true
        });
    }

    failJob(id, error) {
        return this.updateJob(id, {
            status: 'failed',
            stage: 'error',
            message: typeof error === 'string' ? error : (error?.message || 'Failed'),
            error: this._normalizeError(error),
            completed: true
        });
    }

    getJob(id) {
        if (!id) return null;
        const row = this.db.prepare('SELECT * FROM JobRuns WHERE id = ?').get(id);
        if (!row) return null;
        return this._hydrate(row);
    }

    listJobs({ type, limit = 20 } = {}) {
        const stmt = type
            ? this.db.prepare('SELECT * FROM JobRuns WHERE type = ? ORDER BY created_at DESC LIMIT ?')
            : this.db.prepare('SELECT * FROM JobRuns ORDER BY created_at DESC LIMIT ?');
        const rows = type ? stmt.all(type, limit) : stmt.all(limit);
        return rows.map((row) => this._hydrate(row));
    }

    registerSocket(id, socketId) {
        if (!id || !socketId) return null;
        this.updateStmt.run({ id, socket_id: socketId });
        return this.getJob(id);
    }

    _hydrate(row) {
        return {
            id: row.id,
            type: row.type,
            label: row.label,
            status: row.status,
            stage: row.stage,
            message: row.message,
            progress: row.progress,
            stats: row.stats_json ? this._safeParse(row.stats_json, {}) : {},
            metadata: row.metadata_json ? this._safeParse(row.metadata_json, {}) : {},
            logs: row.logs_json ? this._safeParse(row.logs_json, []) : [],
            socketId: row.socket_id,
            error: row.error_message,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            completedAt: row.completed_at,
            deletedAt: row.deleted_at
        };
    }

    _safeParse(value, fallback) {
        try {
            return JSON.parse(value);
        } catch (err) {
            return fallback;
        }
    }

    _normalizeError(error) {
        if (error == null) return null;
        if (typeof error === 'string') return error;
        if (error instanceof Error) {
            return error.stack || error.message;
        }
        try {
            return JSON.stringify(error);
        } catch (e) {
            return String(error);
        }
    }

    _ensureSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS JobRuns (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                label TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                stage TEXT,
                message TEXT,
                progress REAL DEFAULT 0,
                stats_json TEXT,
                metadata_json TEXT,
                logs_json TEXT,
                socket_id TEXT,
                error_message TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                completed_at DATETIME,
                deleted_at DATETIME
            );
        `);

        this.db.exec('CREATE INDEX IF NOT EXISTS idx_jobruns_type_status ON JobRuns(type, status)');
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_jobruns_created_at ON JobRuns(created_at DESC)');
    }
}

module.exports = new JobStateStore();
module.exports.JobStateStore = JobStateStore;
