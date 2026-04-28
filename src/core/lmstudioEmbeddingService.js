// LM Studio Embedding Service
// Bridges the LM Studio REST API to the unified embedding pipeline interface.

const fetch = require('node-fetch');
const {
    getEmbeddingModel,
    getLmStudioConfig,
    enforceRateLimit,
    validateEmbeddingInput
} = require('./embeddingConfig');

const DEFAULT_TIMEOUT_MS = 30000;

function resolveBaseUrl(override) {
    let candidate = override;
    if (!candidate) {
        const cfg = getLmStudioConfig();
        candidate = cfg?.baseUrl || 'http://127.0.0.1:1234';
    }
    if (typeof candidate !== 'string') {
        candidate = 'http://127.0.0.1:1234';
    }
    let value = candidate.trim();
    if (!value) {
        value = 'http://127.0.0.1:1234';
    }
    if (!/^https?:\/\//i.test(value)) {
        value = `http://${value}`;
    }
    try {
        const url = new URL(value);
        return url.origin.replace(/\/$/, '');
    } catch (err) {
        console.warn('[LM Studio] Invalid base URL override supplied. Falling back to default.', err.message);
        return 'http://127.0.0.1:1234';
    }
}

function getConfiguredModel() {
    const explicit = getEmbeddingModel();
    if (explicit) return explicit;
    const cfg = getLmStudioConfig();
    if (cfg?.model) return cfg.model;
    return null;
}

function fallbackDimension() {
    const cfg = getLmStudioConfig();
    const list = Array.isArray(cfg?.supportedDimensions) ? cfg.supportedDimensions : [];
    if (list.length) return list[list.length - 1];
    return 768;
}

async function listModels({ baseUrl } = {}) {
    const url = `${resolveBaseUrl(baseUrl)}/api/v0/models`;
    const response = await fetch(url, { method: 'GET', timeout: DEFAULT_TIMEOUT_MS });
    if (!response.ok) {
        const message = await safeReadText(response);
        throw new Error(`LM Studio models request failed: ${response.status} ${message}`);
    }
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.data)) {
        throw new Error('LM Studio models response invalid. Expected { data: [] }');
    }
    return payload.data.filter(entry => (entry?.type || '').toLowerCase() === 'embeddings');
}

async function safeReadText(response) {
    try {
        return await response.text();
    } catch (err) {
        return '[unreadable body]';
    }
}

async function embedTexts(texts, { workerId = 'main' } = {}) {
    const validatedInput = validateEmbeddingInput(texts);
    const arr = Array.isArray(validatedInput) ? validatedInput : [validatedInput];
    const model = getConfiguredModel();
    if (!model) {
        throw new Error('LM Studio model not configured. Please select a model in settings.');
    }

    await enforceRateLimit(workerId);

    const requestBody = {
        model,
        input: arr
    };

    const url = `${resolveBaseUrl()}/api/v0/embeddings`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
            timeout: DEFAULT_TIMEOUT_MS
        });

        if (!response.ok) {
            const message = await safeReadText(response);
            throw new Error(`LM Studio embeddings request failed: ${response.status} ${message}`);
        }

        const payload = await response.json();
        if (!payload || !Array.isArray(payload.data)) {
            throw new Error('LM Studio embeddings response invalid. Expected { data: [] }');
        }

        const vectors = payload.data.map((item) => {
            const embedding = Array.isArray(item?.embedding) ? item.embedding : null;
            if (!embedding || !embedding.length) {
                return new Float32Array(fallbackDimension());
            }
            return Float32Array.from(embedding);
        });

        return vectors;
    } catch (error) {
        console.error('[LM Studio] Batch embedding failed:', error.message);
        // Retry per-text to salvage results
        const out = [];
        for (const text of arr) {
            try {
                await enforceRateLimit(workerId);
                const singleResponse = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model, input: text }),
                    timeout: DEFAULT_TIMEOUT_MS
                });

                if (!singleResponse.ok) {
                    throw new Error(await safeReadText(singleResponse));
                }

                const singlePayload = await singleResponse.json();
                const embedding = Array.isArray(singlePayload?.data?.[0]?.embedding)
                    ? singlePayload.data[0].embedding
                    : null;

                if (embedding && embedding.length) {
                    out.push(Float32Array.from(embedding));
                } else {
                    out.push(new Float32Array(fallbackDimension()));
                }
            } catch (singleErr) {
                console.warn('[LM Studio] Individual embedding failed:', singleErr.message);
                out.push(new Float32Array(fallbackDimension()));
            }
        }

        return out;
    }
}

module.exports = {
    embedTexts,
    listModels
};
