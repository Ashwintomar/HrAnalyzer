const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { JobStateStore } = require('../src/core/jobStateStore');

function createTempDbPath() {
    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return path.join(os.tmpdir(), `job-state-store-${unique}.db`);
}

function initializeJobRunsSchema(dbPath) {
    const db = new Database(dbPath);
    db.exec(`
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
    db.close();
}

function cleanupDbFiles(dbPath) {
    const variants = [dbPath, `${dbPath}-journal`, `${dbPath}-wal`, `${dbPath}-shm`];
    for (const file of variants) {
        if (fs.existsSync(file)) {
            fs.unlinkSync(file);
        }
    }
}

async function withStore(testFn) {
    const dbPath = createTempDbPath();
    initializeJobRunsSchema(dbPath);
    const store = new JobStateStore(dbPath);
    try {
        await testFn(store);
    } finally {
        store.close();
        cleanupDbFiles(dbPath);
    }
}

async function runTests() {
    console.log('Test: createJob persists defaults and metadata');
    await withStore(async (store) => {
        const job = store.createJob({ type: 'gmail', label: 'Sync Inbox', metadata: { account: 'ops' } });
        assert.ok(job.id);
        assert.strictEqual(job.type, 'gmail');
        assert.strictEqual(job.status, 'pending');
        assert.strictEqual(job.stage, 'queued');
        assert.strictEqual(job.progress, 0);
        assert.deepStrictEqual(job.metadata, { account: 'ops' });
        assert.deepStrictEqual(job.stats, {});
    });

    console.log('Test: updateJob merges stats/metadata and tracks progress');
    await withStore(async (store) => {
        const job = store.createJob({ type: 'gmail' });
        const updated = store.updateJob(job.id, {
            status: 'running',
            stage: 'fetching',
            message: 'Fetching threads',
            progress: 42,
            stats: { fetched: 12 },
            metadata: { folder: 'INBOX' }
        });
        assert.strictEqual(updated.status, 'running');
        assert.strictEqual(updated.progress, 42);
        assert.deepStrictEqual(updated.stats, { fetched: 12 });
        assert.deepStrictEqual(updated.metadata, { folder: 'INBOX' });

        const second = store.updateJob(job.id, {
            stats: { attachments: 3 },
            metadata: { folder: 'INBOX', user: 'qa' }
        });
        assert.deepStrictEqual(second.stats, { fetched: 12, attachments: 3 });
        assert.deepStrictEqual(second.metadata, { folder: 'INBOX', user: 'qa' });
    });

    console.log('Test: appendLog caps log history to 100 entries');
    await withStore(async (store) => {
        const job = store.createJob({ type: 'gmail' });
        for (let i = 0; i < 120; i += 1) {
            store.appendLog(job.id, { message: `log-${i}` });
        }
        const refreshed = store.getJob(job.id);
        assert.strictEqual(refreshed.logs.length, 100);
        assert.strictEqual(refreshed.logs[0].message, 'log-20');
        assert.strictEqual(refreshed.logs[99].message, 'log-119');
    });

    console.log('Test: completeJob and failJob set terminal state');
    await withStore(async (store) => {
        const job = store.createJob({ type: 'gmail' });
        const completed = store.completeJob(job.id, { stats: { processed: 5 } });
        assert.strictEqual(completed.status, 'completed');
        assert.strictEqual(completed.progress, 100);
        assert.deepStrictEqual(completed.stats, { processed: 5 });
        assert.ok(completed.completedAt);

        const failed = store.failJob(job.id, new Error('boom'));
        assert.strictEqual(failed.status, 'failed');
        assert.strictEqual(failed.stage, 'error');
        assert.strictEqual(failed.message, 'boom');
        assert.ok(failed.completedAt);
    });

    console.log('✅ All JobStateStore tests passed');
}

runTests().catch((err) => {
    console.error('❌ JobStateStore tests failed');
    console.error(err);
    process.exitCode = 1;
});
