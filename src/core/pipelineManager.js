// Core Service - AI Pipeline Manager

let PIPELINE = null; // function: async (texts:string[]|string, options) => Float32Array[]
let PIPELINE_LOADING = false;
const { getEmbeddingPipeline, getEmbeddingProviderType: getLocalProviderType } = require('./localEmbeddingFallback');
const { getEmbeddingMode, getEmbeddingProvider } = require('./embeddingConfig');

// Map providers to their service modules for dynamic loading
const onlineServices = {
    gemini: () => require('./geminiEmbeddingService'),
    mistral: () => require('./mistralEmbeddingService'),
    nvidia: () => require('./nvidiaEmbeddingService'),
    jina: () => require('./jinaEmbeddingService'),
};

const localBridgeServices = {
    lmstudio: () => require('./lmstudioEmbeddingService')
};

function normalizeVector(vec) {
    if (!vec) return vec;
    let sum = 0;
    for (let i = 0; i < vec.length; i++) {
        const x = vec[i];
        sum += x * x;
    }
    const n = Math.sqrt(sum) || 1;
    const out = new Float32Array(vec.length);
    for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n;
    return out;
}

// Lazy loading function for AI pipeline
async function loadPipeline() {
    if (PIPELINE !== null) return PIPELINE;

    if (PIPELINE_LOADING) {
        console.log('AI pipeline is already loading, waiting...');
        while (PIPELINE_LOADING && PIPELINE === null) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (PIPELINE !== null) return PIPELINE;
    }

    PIPELINE_LOADING = true;
    console.log('Loading AI pipeline...');

    try {
        const mode = getEmbeddingMode();
        const provider = getEmbeddingProvider();

        if (mode === 'online') {
            // Strict online mode: do NOT fall back to local if provider is invalid/missing
            if (!onlineServices[provider]) {
                PIPELINE_LOADING = false;
                throw new Error(`[PipelineManager] Online mode selected but unsupported provider '${provider}'. Local fallback is disabled in strict mode.`);
            }
            console.log(`[PipelineManager] Initializing ONLINE ${provider} embedding pipeline`);
            const service = onlineServices[provider]();
            // Wrap online service to L2-normalize embeddings for consistency
            PIPELINE = async (texts, opts = {}) => {
                const arr = Array.isArray(texts) ? texts : [texts];
                const embs = await service.embedTexts(arr, {
                    workerId: opts.workerId || 'main',
                    inputType: opts.inputType,
                    role: opts.role
                });
                const normalized = embs.map(normalizeVector);
                if (!Array.isArray(texts)) return { data: normalized[0] };
                return { data: normalized };
            };
            PIPELINE_LOADING = false;
            return PIPELINE;
        } else {
            if (provider && localBridgeServices[provider]) {
                console.log(`[PipelineManager] Initializing LOCAL bridge provider '${provider}'`);
                const service = localBridgeServices[provider]();
                PIPELINE = async (texts, opts = {}) => {
                    const arr = Array.isArray(texts) ? texts : [texts];
                    const embs = await service.embedTexts(arr, {
                        workerId: opts.workerId || 'main',
                        inputType: opts.inputType,
                        role: opts.role
                    });
                    const normalized = embs.map(normalizeVector);
                    if (!Array.isArray(texts)) return { data: normalized[0] };
                    return { data: normalized };
                };
                PIPELINE_LOADING = false;
                return PIPELINE;
            }
            const embedFn = await getEmbeddingPipeline({ allowTransformersSecondary: false });
            PIPELINE = async (texts, opts = {}) => {
                const arr = Array.isArray(texts) ? texts : [texts];
                const embeddings = await embedFn(arr);
                if (!Array.isArray(texts)) return { data: embeddings[0] };
                return { data: embeddings };
            };
            console.log('AI embedding pipeline loaded via local provider:', getLocalProviderType());
            PIPELINE_LOADING = false;
            return PIPELINE;
        }
    } catch (error) {
        console.error('Error loading embedding pipeline:', error);
        PIPELINE_LOADING = false;
        PIPELINE = null;
        throw error;
    }
}

// Function to safely dispose pipeline
function disposePipeline() {
    // Our wrapper has no heavy disposable resources yet.
    PIPELINE = null;
    PIPELINE_LOADING = false;
    console.log('AI pipeline disposed');
}

// Setup socket events related to the pipeline
function setupPipelineSocketEvents(socket) {
    socket.on('load-pipeline', async () => {
        try {
            socket.emit('pipeline-loading', { status: 'starting' });
            await loadPipeline();
            socket.emit('pipeline-loaded', { success: true });
        } catch (error) {
            socket.emit('pipeline-loaded', { success: false, error: error.message });
        }
    });
}

function getPipelineStatus() {
    return PIPELINE !== null;
}

// Clear pipeline cache when configuration changes
function clearPipelineCache() {
    console.log('Clearing embedding pipeline cache due to configuration change');
    PIPELINE = null;
    PIPELINE_LOADING = false;
    // Also clear local embedding cache if available
    try {
        const { clearEmbeddingCache } = require('./localEmbeddingFallback');
        clearEmbeddingCache();
    } catch (e) {
        // Ignore if not available
    }
}

module.exports = {
    loadPipeline,
    disposePipeline,
    setupPipelineSocketEvents,
    getPipelineStatus,
    clearPipelineCache
};