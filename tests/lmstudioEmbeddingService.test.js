const assert = require('assert');
const path = require('path');

const fetchModuleId = require.resolve('node-fetch');
const realFetch = require('node-fetch');

const mockQueue = [];

function queueResponse(responseFactory) {
    mockQueue.push(responseFactory);
}

async function mockFetch(url, options = {}) {
    if (!mockQueue.length) {
        throw new Error(`No mock fetch response queued for ${url}`);
    }
    const factory = mockQueue.shift();
    const response = factory(url, options);
    if (!response || typeof response !== 'object') {
        throw new Error('Mock fetch factory must return a response-like object');
    }
    return response;
}

function createResponse({ ok = true, status = 200, json, text }) {
    const jsonFn = typeof json === 'function' ? json : async () => json;
    const textFn = typeof text === 'function' ? text : async () => JSON.stringify(await jsonFn());
    return {
        ok,
        status,
        async json() { return jsonFn(); },
        async text() { return textFn(); }
    };
}

function resetMocks() {
    mockQueue.length = 0;
}

async function runTests() {
    require.cache[fetchModuleId] = { exports: mockFetch };
    delete require.cache[require.resolve('../src/core/lmstudioEmbeddingService')];
    delete require.cache[require.resolve('../src/core/embeddingConfig')];

    const embeddingConfig = require('../src/core/embeddingConfig');
    const service = require('../src/core/lmstudioEmbeddingService');

    console.log('Test: listModels filters embedding entries');
    resetMocks();
    queueResponse(() => createResponse({
        json: () => ({
            data: [
                { id: 'embed-model', type: 'embeddings' },
                { id: 'chat-model', type: 'llm' }
            ]
        })
    }));

    const models = await service.listModels({ baseUrl: 'http://mock:1234' });
    assert.strictEqual(Array.isArray(models), true);
    assert.deepStrictEqual(models.map((m) => m.id), ['embed-model']);

    console.log('Test: embedTexts returns Float32Array list');
    resetMocks();
    queueResponse(() => createResponse({
        json: () => ({
            data: [
                { embedding: [0.1, 0.2, 0.3] }
            ]
        })
    }));

    embeddingConfig.setEmbeddingConfig({
        mode: 'local',
        provider: 'lmstudio',
        lmStudioBaseUrl: 'http://mock:1234',
        lmStudioModel: 'test-embed',
        lmStudioDimensions: '384, 768'
    });

    const result = await service.embedTexts('hello world', { workerId: 'worker-1' });
    assert.strictEqual(Array.isArray(result), true);
    assert.strictEqual(result.length, 1);
    assert.ok(result[0] instanceof Float32Array);
    assert.strictEqual(result[0].length, 3);

    console.log('Test: embedTexts retries per-input on failure');
    resetMocks();
    // First batch call fails with 500
    queueResponse(() => createResponse({
        ok: false,
        status: 500,
        text: () => 'server error'
    }));
    // Second call succeeds for first text
    queueResponse(() => createResponse({
        json: () => ({
            data: [
                { embedding: [1, 0] }
            ]
        })
    }));
    // Third call succeeds for second text
    queueResponse(() => createResponse({
        json: () => ({
            data: [
                { embedding: [0, 1] }
            ]
        })
    }));

    const fallback = await service.embedTexts(['first', 'second']);
    assert.strictEqual(fallback.length, 2);
    assert.deepStrictEqual(Array.from(fallback[0]), [1, 0]);
    assert.deepStrictEqual(Array.from(fallback[1]), [0, 1]);

    console.log('✅ All LM Studio embedding service tests passed');
}

runTests()
    .catch((err) => {
        console.error('❌ LM Studio embedding service tests failed');
        console.error(err);
        process.exitCode = 1;
    })
    .finally(() => {
        require.cache[fetchModuleId] = { exports: realFetch };
    });
