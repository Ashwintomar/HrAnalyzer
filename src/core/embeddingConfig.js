// Embedding Configuration & Mode Manager
// Controls whether embeddings use local pipelines or online Gemini embeddings.

let embeddingMode = 'local'; // 'local' | 'online'
let apiKeys = [];
let model = 'gemini-embedding-001';
let provider = 'gemini'; // 'gemini' | 'mistral' | 'nvidia' | 'jina' | 'local' | 'lmstudio'
let keyIndex = 0;
let timeoutSeconds = 2; // User-configurable timeout between API key usage
let embeddingConcurrency = undefined; // Optional user-provided concurrency hint from frontend
// Embedding dimensionality for online providers that support it (Gemini supported sizes: 3072,2048,1536,768,512,256,128)
let embeddingDimensions = 2048;
const DEFAULT_LM_STUDIO_BASE_URL = 'http://127.0.0.1:1234';
let lmStudioConfig = {
    baseUrl: DEFAULT_LM_STUDIO_BASE_URL,
    model: '',
    supportedDimensions: []
};
// Per-worker last call timestamps for simple rate limiting
const lastCallTs = new Map();
// Per-key usage timestamps for timeout enforcement
const keyUsageTs = new Map();
const RATE_LIMIT_MS = 2000; // 2 second per-worker as requested

function normalizeLmStudioBaseUrl(input) {
    if (!input || typeof input !== 'string') return lmStudioConfig.baseUrl || DEFAULT_LM_STUDIO_BASE_URL;
    let value = input.trim();
    if (!value) return lmStudioConfig.baseUrl || DEFAULT_LM_STUDIO_BASE_URL;
    if (!/^https?:\/\//i.test(value)) {
        value = `http://${value}`;
    }
    try {
        const url = new URL(value);
        return url.origin.replace(/\/$/, '');
    } catch (err) {
        console.warn(`Invalid LM Studio base URL '${input}'. Keeping previous value.`);
        return lmStudioConfig.baseUrl || DEFAULT_LM_STUDIO_BASE_URL;
    }
}

function parseSupportedDimensions(value) {
    if (Array.isArray(value)) {
        return value
            .map(v => parseInt(v, 10))
            .filter(v => Number.isFinite(v) && v > 0)
            .filter((v, idx, arr) => arr.indexOf(v) === idx)
            .sort((a, b) => a - b);
    }
    if (typeof value === 'string') {
        return value.split(',')
            .map(v => parseInt(v.trim(), 10))
            .filter(v => Number.isFinite(v) && v > 0)
            .filter((v, idx, arr) => arr.indexOf(v) === idx)
            .sort((a, b) => a - b);
    }
    if (Number.isFinite(value) && value > 0) {
        return [parseInt(value, 10)];
    }
    return [];
}

function setEmbeddingConfig(cfg = {}) {
    // Capture previous values BEFORE applying changes for accurate cache clearing
    const prev = { 
        model, 
        provider, 
        mode: embeddingMode,
        lmStudioBaseUrl: lmStudioConfig.baseUrl,
        lmStudioModel: lmStudioConfig.model
    };
    const oldModel = model;
    if (cfg.mode && (cfg.mode === 'local' || cfg.mode === 'online')) embeddingMode = cfg.mode;
    if (Array.isArray(cfg.apiKeys)) {
        apiKeys = cfg.apiKeys.filter(Boolean);
        keyIndex = 0; // reset rotation
    }
    if (cfg.model) model = cfg.model; // allow override, default stays as required
    if (cfg.provider) provider = cfg.provider; // track which provider is being used
    if (cfg.timeoutSeconds !== undefined && cfg.timeoutSeconds > 0) {
        timeoutSeconds = cfg.timeoutSeconds; // set user-configurable timeout
    }
    if (cfg.embeddingConcurrency !== undefined) {
        const n = parseInt(cfg.embeddingConcurrency, 10);
        if (!isNaN(n) && n > 0) {
            embeddingConcurrency = n;
        }
    }
    if (cfg.embeddingDimensions !== undefined) {
        const d = parseInt(cfg.embeddingDimensions, 10);
        if (!isNaN(d) && d > 0) {
            embeddingDimensions = d;
        } else {
            console.warn(`Invalid embeddingDimensions '${cfg.embeddingDimensions}'. Expected positive integer. Keeping ${embeddingDimensions}.`);
        }
    }
    
    const lmStudioUpdates = {};
    if (cfg.lmStudioConfig && typeof cfg.lmStudioConfig === 'object') {
        Object.assign(lmStudioUpdates, cfg.lmStudioConfig);
    }
    if (cfg.lmStudioBaseUrl !== undefined) lmStudioUpdates.baseUrl = cfg.lmStudioBaseUrl;
    if (cfg.lmStudioModel !== undefined) lmStudioUpdates.model = cfg.lmStudioModel;
    if (cfg.lmStudioDimensions !== undefined) lmStudioUpdates.supportedDimensions = cfg.lmStudioDimensions;

    if (Object.keys(lmStudioUpdates).length > 0) {
        if (lmStudioUpdates.baseUrl !== undefined) {
            lmStudioConfig.baseUrl = normalizeLmStudioBaseUrl(lmStudioUpdates.baseUrl);
        }
        if (lmStudioUpdates.model !== undefined) {
            lmStudioConfig.model = (lmStudioUpdates.model || '').toString();
            if (!cfg.model) {
                model = lmStudioConfig.model || model;
            }
        }
        if (lmStudioUpdates.supportedDimensions !== undefined) {
            const parsed = parseSupportedDimensions(lmStudioUpdates.supportedDimensions);
            if (parsed.length) {
                lmStudioConfig.supportedDimensions = parsed;
                if (cfg.embeddingDimensions === undefined) {
                    embeddingDimensions = parsed[parsed.length - 1] || embeddingDimensions;
                }
            } else {
                lmStudioConfig.supportedDimensions = [];
            }
        }
    }

    if (provider === 'lmstudio' && !model && lmStudioConfig.model) {
        model = lmStudioConfig.model;
    }

    // Normalize common shorthand model names
    const normalizeModel = (m) => {
        if (!m) return m;
        const ml = String(m).toLowerCase();
        if (ml === 'gemini') return 'gemini-embedding-001';
        if (ml === 'mistral') return 'mistral-embed';
        return m;
    };
    model = normalizeModel(model);

    // Infer provider from model if not provided, or auto-correct mismatched provider when clearly inferable
    const inferProviderFromModel = (m) => {
        if (!m) return null;
        if (m.startsWith('gemini-')) return 'gemini';
        if (m === 'mistral-embed') return 'mistral';
        if (m.startsWith('nvidia/')) return 'nvidia';
        if (m.startsWith('baai/')) return 'nvidia';
        if (m.startsWith('jina-embeddings-')) return 'jina';
        if (m.startsWith('bge-')) return 'local';
        return null;
    };

    if (cfg.model && !cfg.provider) {
        const inferred = inferProviderFromModel(model);
        if (inferred) {
            if (provider !== inferred) {
                console.warn(`Auto-correcting provider to '${inferred}' based on model '${model}'.`);
            }
            provider = inferred;
        }
    }

    // If both provided but mismatched, prefer model-implied provider in online mode to avoid invalid combos on toggle
    if (cfg.model && cfg.provider && embeddingMode === 'online') {
        const inferred = inferProviderFromModel(model);
        if (inferred && inferred !== provider) {
            console.warn(`Provider '${provider}' mismatches model '${model}'. Overriding provider to '${inferred}' in online mode.`);
            provider = inferred;
        }
    }
    if (cfg.provider && !cfg.model) {
        // Set sensible default model for given provider if model omitted
        const defaultModelByProvider = {
            gemini: 'gemini-embedding-001',
            mistral: 'mistral-embed',
            nvidia: 'nvidia/nv-embedqa-e5-v5',
            jina: 'jina-embeddings-v3',
            local: model // keep current local selection
        };
        const def = defaultModelByProvider[provider];
        if (def && model !== def && embeddingMode !== 'local') {
            console.warn(`No model specified for provider '${provider}', defaulting to '${def}'.`);
            model = def;
        }
    }

    // Strict validation: ensure model/provider coherence, especially in online mode
    if (embeddingMode === 'online') {
        const providerModelAllowList = {
            gemini: ['gemini-embedding-001'],
            mistral: ['mistral-embed'],
            nvidia: ['nvidia/nv-embedqa-e5-v5', 'baai/bge-m3', 'nvidia/llama-3.2-nv-embedqa-1b-v2', 'nvidia/llama-3.2-nemoretriever-300m-embed-v2'],
            jina: ['jina-embeddings-v3', 'jina-embeddings-v4']
        };
        if (!providerModelAllowList[provider]) {
            throw new Error(`Unsupported online provider '${provider}'.`);
        }
        if (!providerModelAllowList[provider].includes(model)) {
            throw new Error(`Model '${model}' is not valid for provider '${provider}'. Allowed: ${providerModelAllowList[provider].join(', ')}`);
        }
    }

    // Clear embedding pipeline cache if model, provider, or mode changed (compare to previous values)
    const lmStudioChanged = provider === 'lmstudio' && (
        lmStudioConfig.baseUrl !== prev.lmStudioBaseUrl ||
        lmStudioConfig.model !== prev.lmStudioModel
    );
    const shouldClearCache = (model !== prev.model) || (provider !== prev.provider) || (embeddingMode !== prev.mode) || lmStudioChanged;

    if (shouldClearCache) {
        try {
            const { clearPipelineCache } = require('./pipelineManager');
            clearPipelineCache();
        } catch (e) {
            // Fallback to local cache clearing only
            try {
                const { clearEmbeddingCache } = require('./localEmbeddingFallback');
                clearEmbeddingCache();
            } catch (e2) {
                // Ignore if not available
            }
        }
    }
}

function getEmbeddingMode() { return embeddingMode; }
function getEmbeddingModel() { return model; }
function getEmbeddingProvider() { return provider; }
function getEmbeddingDimensions() { return embeddingDimensions; }
function getApiKeys() { return apiKeys.slice(); }
function getTimeoutSeconds() { return timeoutSeconds; }
function getEmbeddingConfig() { 
    return { 
        mode: embeddingMode, 
        model, 
        provider, 
        apiKeys: apiKeys.slice(), 
        timeoutSeconds,
        embeddingConcurrency,
        embeddingDimensions,
        lmStudio: { ...lmStudioConfig }
    }; 
}

function getLmStudioConfig() {
    return { ...lmStudioConfig };
}

function getEmbeddingConcurrency() { return embeddingConcurrency; }

function nextApiKey() {
    if (!apiKeys.length) throw new Error('No API keys configured for online embedding mode');
    
    // Ensure valid index bounds
    if (keyIndex >= apiKeys.length || keyIndex < 0) {
        keyIndex = 0;
    }
    
    // Find next available key that's not in timeout using round-robin
    let attempts = 0;
    const maxAttempts = apiKeys.length * 2; // Allow extra attempts for robustness
    let bestKey = null;
    let shortestWaitTime = Infinity;
    
    // First pass: try to find a non-timeout key
    while (attempts < apiKeys.length) {
        const currentKey = apiKeys[keyIndex];
        const keyId = currentKey.slice(-8);
        const lastUsed = keyUsageTs.get(keyId) || 0;
        const timeSinceLastUse = Date.now() - lastUsed;
        const timeoutMs = timeoutSeconds * 1000;
        
        if (timeSinceLastUse >= timeoutMs) {
            // Found an available key
            bestKey = currentKey;
            break;
        } else {
            // Track the key with the shortest remaining wait time
            const remainingWait = timeoutMs - timeSinceLastUse;
            if (remainingWait < shortestWaitTime) {
                shortestWaitTime = remainingWait;
                bestKey = currentKey;
            }
        }
        
        keyIndex = (keyIndex + 1) % apiKeys.length;
        attempts++;
    }
    
    // Use the best available key (either non-timeout or shortest wait)
    const selectedKey = bestKey || apiKeys[keyIndex];
    
    // If all keys are in timeout, warn but continue
    if (shortestWaitTime > 0 && shortestWaitTime < Infinity) {
        const waitSeconds = Math.ceil(shortestWaitTime / 1000);
        console.warn(`All ${apiKeys.length} API keys in timeout, using least-recently-used key (${waitSeconds}s remaining)`);
    }
    
    // Mark this key as used and move to next for round-robin
    markKeyAsUsed(selectedKey);
    keyIndex = (keyIndex + 1) % apiKeys.length;
    
    return selectedKey;
}

function isKeyInTimeout(key) {
    // Skip timeout check for local mode
    if (embeddingMode === 'local') return false;
    
    const keyId = key.slice(-8); // Use last 8 chars as unique ID
    const lastUsed = keyUsageTs.get(keyId);
    if (!lastUsed) return false;
    
    const now = Date.now();
    const timeoutMs = timeoutSeconds * 1000;
    return (now - lastUsed) < timeoutMs;
}

function markKeyAsUsed(key) {
    // Skip marking for local mode
    if (embeddingMode === 'local') return;
    
    const keyId = key.slice(-8); // Use last 8 chars as unique ID
    keyUsageTs.set(keyId, Date.now());
}

function getApiKeyStats() {
    const now = Date.now();
    const timeoutMs = timeoutSeconds * 1000;
    
    const stats = {
        totalKeys: apiKeys.length,
        currentIndex: keyIndex,
        provider: provider,
        timeoutSeconds: timeoutSeconds,
        keys: []
    };
    
    apiKeys.forEach((key, index) => {
        const keyId = key.slice(-8);
        const lastUsed = keyUsageTs.get(keyId) || 0;
        const timeSinceLastUse = now - lastUsed;
        const inTimeout = timeSinceLastUse < timeoutMs;
        const remainingTimeout = inTimeout ? Math.ceil((timeoutMs - timeSinceLastUse) / 1000) : 0;
        
        stats.keys.push({
            index,
            keyId,
            lastUsed: lastUsed ? new Date(lastUsed).toISOString() : 'never',
            timeSinceLastUse: Math.floor(timeSinceLastUse / 1000),
            inTimeout,
            remainingTimeout,
            isCurrent: index === keyIndex
        });
    });
    
    return stats;
}

function validateEmbeddingInput(input) {
    if (!input) {
        throw new Error('Embedding input cannot be null or undefined');
    }
    
    if (Array.isArray(input)) {
        if (input.length === 0) {
            throw new Error('Embedding input array cannot be empty');
        }
        
        const validTexts = input.filter(text => 
            text && typeof text === 'string' && text.trim().length > 0
        );
        
        if (validTexts.length === 0) {
            throw new Error('All embedding input texts are null, empty, or invalid');
        }
        
        if (validTexts.length !== input.length) {
            console.warn(`Filtered ${input.length - validTexts.length} invalid texts from embedding input`);
        }
        
        return validTexts;
    }
    
    if (typeof input === 'string') {
        const trimmed = input.trim();
        if (trimmed.length === 0) {
            throw new Error('Embedding input text cannot be empty');
        }
        return trimmed;
    }
    
    throw new Error('Embedding input must be a string or array of strings');
}

async function enforceRateLimit(workerId = 'main') {
    const now = Date.now();
    const last = lastCallTs.get(workerId) || 0;
    const delta = now - last;
    if (delta < RATE_LIMIT_MS) {
        await new Promise(r => setTimeout(r, RATE_LIMIT_MS - delta));
    }
    lastCallTs.set(workerId, Date.now());
}

module.exports = {
    setEmbeddingConfig,
    getEmbeddingMode,
    getEmbeddingModel,
    getEmbeddingProvider,
    getEmbeddingDimensions,
    getEmbeddingConfig,
    getLmStudioConfig,
    getApiKeys,
    getTimeoutSeconds,
    getEmbeddingConcurrency,
    nextApiKey,
    enforceRateLimit,
    isKeyInTimeout,
    markKeyAsUsed,
    validateEmbeddingInput,
    getApiKeyStats,
    RATE_LIMIT_MS
};
