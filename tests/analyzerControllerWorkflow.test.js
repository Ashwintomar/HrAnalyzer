const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

function createResponse() {
    return {
        statusCode: 200,
        payload: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.payload = payload;
            return this;
        }
    };
}

function withController(rows, testFn) {
    const originalLoad = Module._load;
    const controllerPath = require.resolve('../src/modules/analyzer/analyzerController');

    const state = {
        workerInstances: [],
        submitCalls: [],
        ioEvents: []
    };

    class FakeWorker {
        constructor() {
            this.handlers = {};
            this.posted = [];
            state.workerInstances.push(this);
        }

        on(event, handler) {
            this.handlers[event] = handler;
        }

        postMessage(message) {
            this.posted.push(message);
        }

        terminate() {
            return Promise.resolve();
        }
    }

    class FakeAnalysisEngine {
        constructor() {
            this.db = {
                prepare() {
                    return {
                        all() { return []; },
                        get() { return null; },
                        run() { return { changes: 0 }; }
                    };
                }
            };
        }

        findUniqueResumeUrls(data) {
            return data.map((row, index) => ({
                candidateId: index + 1,
                resumeUrl: row.resume_url || `https://example.com/${index + 1}.pdf`,
                name: `Candidate ${index + 1}`
            }));
        }

        findUniqueResumeUrlsWithStats(data) {
            return {
                candidates: this.findUniqueResumeUrls(data),
                stats: {
                    files: 1,
                    attempted: data.length,
                    inserted: data.length,
                    duplicate_existing: 0,
                    duplicate_in_file: 0,
                    duplicate_across_files: 0,
                    invalid: 0
                }
            };
        }

        canonicalizeResumeUrl(url) {
            return url;
        }

        addLocalPdfCandidate({ fileName, localFilePath }) {
            return {
                duplicate: false,
                candidateId: 1,
                name: 'Local Candidate',
                resumeUrl: `local:${fileName}`,
                localFilePath
            };
        }

        close() {}
    }

    const xlsxStub = {
        read() {
            return {
                SheetNames: ['Sheet1'],
                Sheets: { Sheet1: {} }
            };
        },
        utils: {
            sheet_to_json() {
                return rows;
            }
        }
    };

    const processingManagerStub = {
        async initializeWorkers() {},
        async submitTasks(resumeData, progressCallback, embeddingConfig, jobType) {
            state.submitCalls.push({ resumeData, embeddingConfig, jobType });
            if (progressCallback) {
                progressCallback({
                    message: 'Processing candidate',
                    candidateId: resumeData[0]?.candidateId,
                    stats: { completed: 0, total: resumeData.length }
                });
                progressCallback({
                    message: 'Processing candidate',
                    candidateId: resumeData[0]?.candidateId,
                    stats: { completed: resumeData.length, total: resumeData.length }
                });
            }
            return resumeData.map((item, index) => ({
                taskId: index + 1,
                success: true,
                skipped: false,
                data: { candidateId: item.candidateId }
            }));
        }
    };

    const io = {
        emit(event, payload) {
            state.ioEvents.push({ event, payload });
        },
        sockets: {
            sockets: new Map()
        }
    };

    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'xlsx') return xlsxStub;
        if (request === '../../core/workerPool') return processingManagerStub;
        if (request === './analysisEngine') return FakeAnalysisEngine;
        if (request === '../../databaseSetup') return { setupDatabase: async () => ({ success: true }) };
        if (request === '../../core/pipelineManager') return { loadPipeline: async () => null };
        if (request === '../../core/embeddingConfig') {
            return {
                getEmbeddingConfig: () => ({ mode: 'local', model: 'bge-base', provider: 'local' }),
                setEmbeddingConfig: () => {}
            };
        }
        if (request === 'worker_threads') return { Worker: FakeWorker };
        return originalLoad(request, parent, isMain);
    };

    delete require.cache[controllerPath];
    const createController = require(controllerPath);
    const controller = createController(io);

    const cleanup = () => {
        Module._load = originalLoad;
        delete require.cache[controllerPath];
    };

    return Promise.resolve()
        .then(() => testFn({ controller, state }))
        .finally(cleanup);
}

async function runTests() {
    console.log('Test: ingestCandidates does not post ranking work');
    await withController([{ resume_url: 'https://example.com/alex.pdf' }], async ({ controller, state }) => {
        const req = {
            body: { config: JSON.stringify({ mode: 'local', model: 'bge-base', provider: 'local' }) },
            file: { buffer: Buffer.from('fake-workbook') }
        };
        const res = createResponse();

        await controller.ingestCandidates(req, res);
        await new Promise((resolve) => setImmediate(resolve));

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.payload.success, true);
        assert.strictEqual(state.submitCalls.length, 1);
        assert.deepStrictEqual(state.workerInstances[0].posted, []);
    });

    console.log('Test: bulkIngest keeps Excel-only ingest on the non-ranking path');
    await withController([{ resume_url: 'https://example.com/jordan.pdf' }], async ({ controller, state }) => {
        const tempFile = path.join(os.tmpdir(), `bulk-ingest-${Date.now()}.xlsx`);
        fs.writeFileSync(tempFile, 'fake-excel');

        try {
            const req = {
                body: { config: JSON.stringify({ mode: 'local', model: 'bge-base', provider: 'local' }) },
                files: [{ originalname: 'candidates.xlsx', path: tempFile }]
            };
            const res = createResponse();

            await controller.bulkIngest(req, res);
            await new Promise((resolve) => setImmediate(resolve));

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.payload.success, true);
            assert.strictEqual(state.submitCalls.length, 1);
            assert.deepStrictEqual(state.workerInstances[0].posted, []);
        } finally {
            if (fs.existsSync(tempFile)) {
                fs.unlinkSync(tempFile);
            }
        }
    });

    console.log('✅ Analyzer controller workflow tests passed');
}

runTests().catch((error) => {
    console.error('❌ Analyzer controller workflow tests failed');
    console.error(error);
    process.exitCode = 1;
});
