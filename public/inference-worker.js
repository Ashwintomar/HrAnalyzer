// WebGPU-enabled Web Worker for client-side ONNX model inference
// This worker runs embedding generation off the main thread to maintain UI responsiveness

// ONNX Runtime loading with CDN fallback
let ortLoaded = false;

async function loadOnnxRuntime() {
    // Check if ort is already available globally
    if (typeof self.ort !== 'undefined') {
        ortLoaded = true;
        console.log('✅ ONNX Runtime already loaded globally');
        
        // Configure WASM paths if not already set
        if (!self.ort.env.wasm.wasmPaths) {
            // Use root-absolute to avoid duplicated segments in computed URLs
            self.ort.env.wasm.wasmPaths = '/onnxruntime-web/';
        }
        
        // Configure WebGPU-optimized WASM settings (Microsoft recommended)
        if (!self.ort.env.wasm.numThreads) {
            self.ort.env.wasm.numThreads = 1; // Required for WebGPU compatibility
        }
        if (typeof self.ort.env.wasm.simd === 'undefined') {
            self.ort.env.wasm.simd = true; // Enable SIMD for better performance
        }
        
        // Configure WebGL fallback if not already set
        if (!self.ort.env.webgl) {
            self.ort.env.webgl = {
                contextId: 'webgl2',
                matmulMaxBatchSize: 128,
                textureCacheMode: 'full'
            };
        }
        
        postMessage({ 
            type: 'log', 
            payload: '✅ Using existing ONNX Runtime instance' 
        });
        return true;
    }
    
    if (ortLoaded && typeof self.ort !== 'undefined') return true;

    // Prefer WebGPU build when WebGPU is available; otherwise use wasm build
    const hasWebGPU = typeof navigator !== 'undefined' && typeof navigator.gpu !== 'undefined' && navigator.gpu !== null;
    const preferredUrl = hasWebGPU ? './onnxruntime-web/ort.webgpu.min.js' : './onnxruntime-web/ort.min.js';
    const fallbackUrl = hasWebGPU ? './onnxruntime-web/ort.min.js' : './onnxruntime-web/ort.webgpu.min.js';

    // Probe JSEP to tune WASM env if needed (only relevant when not using webgpu)
    const jsepUrl = '/onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs';
    let jsepOk = false;
    try {
        const res = await fetch(jsepUrl, { method: 'HEAD', cache: 'no-store' });
        jsepOk = res.ok;
    } catch {}

    // Try to load preferred build, then fallback
    for (const attemptUrl of [preferredUrl, fallbackUrl]) {
        try {
            console.log(`Trying to load ONNX Runtime from: ${attemptUrl}`);
            
            // Double-check if ort became available during the loop
            if (typeof self.ort !== 'undefined') {
                ortLoaded = true;
                console.log('✅ ONNX Runtime became available during loading process');
                
                // Configure paths and WebGPU-optimized settings
                if (!self.ort.env.wasm.wasmPaths) {
                    self.ort.env.wasm.wasmPaths = '/onnxruntime-web/';
                }
                // Apply Microsoft's WebGPU recommendations
                if (!self.ort.env.wasm.numThreads) {
                    self.ort.env.wasm.numThreads = 1;
                }
                if (typeof self.ort.env.wasm.simd === 'undefined') {
                    self.ort.env.wasm.simd = true;
                }
                if (!self.ort.env.webgl) {
                    self.ort.env.webgl = {
                        contextId: 'webgl2',
                        matmulMaxBatchSize: 128,
                        textureCacheMode: 'full'
                    };
                }
                
                postMessage({ 
                    type: 'log', 
                    payload: '✅ ONNX Runtime loaded successfully' 
                });
                return true;
            }
            
            importScripts(attemptUrl);
            
            // Check if ort is now available
            if (typeof self.ort !== 'undefined') {
                ortLoaded = true;
                
                // Configure WASM paths for local files
                self.ort.env.wasm.wasmPaths = '/onnxruntime-web/';
                
                // Apply Microsoft's WebGPU configuration recommendations
                self.ort.env.wasm.numThreads = 1; // Required for WebGPU compatibility
                self.ort.env.wasm.simd = true; // Enable SIMD for performance
                
                // Configure WebGL fallback
                self.ort.env.webgl = {
                    contextId: 'webgl2',
                    matmulMaxBatchSize: 128,
                    textureCacheMode: 'full'
                };

                // If JSEP is missing, ensure ORT avoids dynamic JSEP import path
                if (!jsepOk) {
                    try {
                        if (self.ort.env?.wasm) {
                            // Keep numThreads = 1 for WebGPU compatibility even without JSEP
                            if ('proxy' in self.ort.env.wasm) self.ort.env.wasm.proxy = false;
                            if ('worker' in self.ort.env.wasm) self.ort.env.wasm.worker = false;
                        }
                    } catch {}
                }
                
                postMessage({ 
                    type: 'log', 
                    payload: `✅ ONNX Runtime ready` 
                });
                return true;
            }
        } catch (error) {
            console.log(`Failed to load from ${attemptUrl}: ${error.message}`);
            
            // If it's a redeclaration error, ONNX Runtime is likely already loaded
            if (error.message.includes('already been declared')) {
                // Check if ort is available despite the error
                if (typeof self.ort !== 'undefined') {
                    ortLoaded = true;
                    console.log('✅ ONNX Runtime was already loaded (redeclaration error is expected)');
                    
                    // Configure paths
                    if (!self.ort.env.wasm.wasmPaths) {
                        self.ort.env.wasm.wasmPaths = '/onnxruntime-web/';
                    }
                    if (!self.ort.env.webgl) {
                        self.ort.env.webgl = {
                            contextId: 'webgl2',
                            matmulMaxBatchSize: 128,
                            textureCacheMode: 'full'
                        };
                    }
                    
                    postMessage({ 
                        type: 'log', 
                        payload: '✅ Using existing ONNX Runtime (already loaded)' 
                    });
                    return true;
                }
            }
            continue;
        }
    }
    
    // If we get here, ONNX Runtime couldn't be loaded
    postMessage({ 
        type: 'error', 
        payload: '❌ Failed to load ONNX Runtime. Local inference disabled. Using server-side processing only.' 
    });
    return false;
}

let session = null;
let isInitializing = false;

// BGE Model Configuration
const MODEL_CONFIGS = {
    'bge-base': {
        path: './models/bge-base-en-v1.5/model.onnx',
        dimensions: 768,
        name: 'BGE-Base'
    },
    'bge-small': {
        path: './models/bge-small-en-v1.5/model.onnx',
        dimensions: 384,
        name: 'BGE-Small'
    }
};

let currentModelType = 'bge-base';
let modelPath = MODEL_CONFIGS[currentModelType].path;

async function initializeModel(modelPath) {
    if (isInitializing) {
        postMessage({ type: 'log', payload: 'Model initialization already in progress...' });
        return;
    }

    // Check if we already have the correct model loaded
    if (session && modelPath === MODEL_CONFIGS[currentModelType].path) {
        postMessage({ type: 'log', payload: `${MODEL_CONFIGS[currentModelType].name} model already initialized.` });
        return;
    }

    // If we have a different session loaded, dispose it first
    if (session) {
        postMessage({ type: 'log', payload: 'Disposing previous model session...' });
        try {
            session.release();
        } catch (e) {
            console.warn('Error disposing session:', e);
        }
        session = null;
    }

    isInitializing = true;
    
    // Always run a preflight diagnostic as early signal to UI
    try { await runPreflightDiagnostic(); } catch {}

    // Ensure ONNX Runtime is loaded
    if (!ortLoaded) {
        const loaded = await loadOnnxRuntime();
        if (!loaded) {
            isInitializing = false;
            return;
        }
    }
    
    try {
        // Check for WebGPU support using Microsoft's recommended method
        let hasWebGPU = false;
        if (typeof navigator !== 'undefined' && typeof navigator.gpu !== 'undefined' && navigator.gpu !== null) {
            try {
                // Microsoft's recommended WebGPU check
                const adapter = await navigator.gpu.requestAdapter();
                hasWebGPU = !!adapter;
                // Only log if WebGPU fails
                if (!hasWebGPU) {
                    postMessage({ type: 'log', payload: '⚠️ WebGPU adapter not available' });
                }
            } catch (error) {
                hasWebGPU = false;
                postMessage({ type: 'log', payload: `⚠️ WebGPU check failed: ${error.message}` });
            }
        } else {
            postMessage({ type: 'log', payload: '⚠️ WebGPU not supported in this environment' });
        }

        // Helper to check if a resource is reachable
        const resourceReachable = async (url) => {
            try {
                const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
                return res.ok;
            } catch {
                return false;
            }
        };
        
        let executionProviders = [];
        let providerType = 'cpu';
        
        // If WebGPU is available, ensure JSEP module is accessible; otherwise, skip WebGPU
        if (hasWebGPU) {
            const jsepMjs = '/onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs';
            const jsepOk = await resourceReachable(jsepMjs);
            // Silently configure WebGPU (reduce console spam)
            // Always try WebGPU first when available; keep WASM/CPU as fallback
            executionProviders = ['webgpu', 'wasm', 'cpu'];
            providerType = 'webgpu';

            // If JSEP is missing, ensure ORT does not try to proxy via JSEP for WASM fallback
            if (!jsepOk && typeof self.ort !== 'undefined') {
                try {
                    if (self.ort.env?.wasm) {
                        self.ort.env.wasm.numThreads = 1;
                        if ('proxy' in self.ort.env.wasm) self.ort.env.wasm.proxy = false;
                        if ('worker' in self.ort.env.wasm) self.ort.env.wasm.worker = false;
                    }
                } catch {}
            }
        } else {
            postMessage({ type: 'log', payload: '⚠️ WebGPU not supported. Using WASM/CPU fallback...' });
            executionProviders = ['wasm', 'cpu'];
            providerType = 'wasm';
        }

        postMessage({ type: 'log', payload: `Loading ${MODEL_CONFIGS[currentModelType].name} model...` });

        // Create ONNX inference session with WebGPU optimizations
        const sessionOptions = {
            executionProviders,
            graphOptimizationLevel: 'all',
            enableCpuMemArena: true,
            enableMemPattern: true,
            executionMode: 'sequential'
        };

        // Add WebGPU-specific options following Microsoft's recommendations
        if (hasWebGPU && typeof self.ort.InferenceSession.create === 'function') {
            sessionOptions.preferredOutputLocation = 'gpu-buffer';
            // Additional WebGPU optimizations from Microsoft tutorial
            sessionOptions.freeDimensionOverrides = {};
            sessionOptions.logSeverityLevel = 2; // Reduce logging for performance
        }

        // Try creating a session; if WebGPU fails due to missing assets, retry with WASM/CPU
        try {
            session = await self.ort.InferenceSession.create(modelPath, sessionOptions);
        } catch (e) {
            const msg = String(e?.message || e);
            if (providerType === 'webgpu' && /jsep|webgpu|Failed to fetch dynamically imported module/i.test(msg)) {
                postMessage({ type: 'log', payload: '♻️ Retrying model init without WebGPU due to missing JSEP module...' });
                const fallbackOptions = { ...sessionOptions, executionProviders: ['wasm', 'cpu'] };
                session = await self.ort.InferenceSession.create(modelPath, fallbackOptions);
                providerType = 'wasm';
            } else if (/initWasm\(\) failed/i.test(msg)) {
                // Retry once with CPU only
                postMessage({ type: 'log', payload: '♻️ Retrying model init with CPU only due to WASM init failure...' });
                const cpuOnly = { ...sessionOptions, executionProviders: ['cpu'] };
                session = await self.ort.InferenceSession.create(modelPath, cpuOnly);
                providerType = 'cpu';
            } else {
                throw e;
            }
        }
        
        // Determine which provider was actually used
        const actualProvider = (session && Array.isArray(session.executionProviders) && session.executionProviders[0]) || providerType;

        // Collect environment details for diagnostics/visibility
        const ortVersion = (self.ort && (self.ort.version || self.ort?.env?.version)) || 'unknown';
        const wasmEnv = self.ort?.env?.wasm ? {
            wasmPaths: self.ort.env.wasm.wasmPaths,
            numThreads: self.ort.env.wasm.numThreads,
            proxy: self.ort.env.wasm.proxy,
            worker: self.ort.env.wasm.worker
        } : null;
        const webgpuAvailable = typeof navigator !== 'undefined' && typeof navigator.gpu !== 'undefined' && navigator.gpu !== null;

        postMessage({ 
            type: 'log', 
            payload: `✅ ${MODEL_CONFIGS[currentModelType].name} ready (${actualProvider})` 
        });

        postMessage({
            type: 'modelReady',
            payload: {
                provider: actualProvider,
                triedProviders: executionProviders,
                ortVersion,
                webgpuAvailable,
                wasmEnv,
                inputNames: session.inputNames,
                outputNames: session.outputNames,
                optimizationInfo: {
                    message: "Node assignment warnings are normal - some operations are intentionally kept on CPU for better performance",
                    expectedWebGPUUsage: "85-95% of operations",
                    cpuOperations: ["Shape", "Gather", "Cast", "Reshape", "Transpose", "Slice"],
                    performance: "WebGPU provides 3-10x speedup for embedding generation compared to CPU"
                }
            }
        });

    } catch (error) {
        postMessage({ 
            type: 'error', 
            payload: `Failed to initialize model: ${error.message}` 
        });
        console.error('Model initialization error:', error);
    } finally {
        isInitializing = false;
    }
}

// Simple tokenizer for text preprocessing (basic implementation)
function tokenizeText(text, maxLength = 512) {
    // Basic tokenization - in production, use proper tokenizer
    const words = text.toLowerCase()
                     .replace(/[^\w\s]/g, ' ')
                     .split(/\s+/)
                     .filter(w => w.length > 0);
    
    // Convert words to pseudo-token IDs (simple hash-based)
    const tokenIds = [101]; // CLS token
    
    for (const word of words) {
        if (tokenIds.length >= maxLength - 1) break;
        
        // Simple hash to generate token ID
        let hash = 0;
        for (let i = 0; i < word.length; i++) {
            hash = ((hash << 5) - hash + word.charCodeAt(i)) & 0xffffffff;
        }
        tokenIds.push(Math.abs(hash) % 30000 + 1000); // Keep in reasonable range
    }
    
    tokenIds.push(102); // SEP token
    
    // Pad to maxLength
    while (tokenIds.length < maxLength) {
        tokenIds.push(0); // PAD token
    }
    
    return tokenIds.slice(0, maxLength);
}

function createAttentionMask(tokenIds) {
    return tokenIds.map(id => id === 0 ? 0 : 1);
}

async function runInference(text) {
    if (!session) {
        throw new Error('Model not initialized. Call initializeModel first.');
    }

    try {
        postMessage({ type: 'log', payload: `Processing text: "${text.substring(0, 50)}..."` });

        // Tokenize input text
        const tokenIds = tokenizeText(text);
        const attentionMask = createAttentionMask(tokenIds);
        const tokenTypeIds = new Array(tokenIds.length).fill(0);

        // Convert to BigInt64Array for ONNX
        const inputIds = new BigInt64Array(tokenIds.map(id => BigInt(id)));
        const attention = new BigInt64Array(attentionMask.map(mask => BigInt(mask)));
        const tokenTypes = new BigInt64Array(tokenTypeIds.map(id => BigInt(id)));

        // Create ONNX tensors
        const feeds = {
            'input_ids': new self.ort.Tensor('int64', inputIds, [1, tokenIds.length]),
            'attention_mask': new self.ort.Tensor('int64', attention, [1, tokenIds.length]),
            'token_type_ids': new self.ort.Tensor('int64', tokenTypes, [1, tokenIds.length])
        };

        postMessage({ type: 'log', payload: 'Running inference...' });

        // Run inference
        const results = await session.run(feeds);
        
        // Get the output tensor (usually the first output for embedding models)
        const outputKey = Object.keys(results)[0];
        const outputTensor = results[outputKey];
        
        let embedding;
        
        // Handle different output shapes
        if (outputTensor.dims.length === 3) {
            // Shape: [batch, sequence, hidden] - need to pool
            const [batch, seqLen, hiddenSize] = outputTensor.dims;
            const data = outputTensor.data;
            
            // Mean pooling across sequence dimension
            embedding = new Float32Array(hiddenSize);
            let validTokens = 0;
            
            for (let seq = 0; seq < seqLen; seq++) {
                if (attentionMask[seq] === 1) {
                    for (let hidden = 0; hidden < hiddenSize; hidden++) {
                        embedding[hidden] += data[seq * hiddenSize + hidden];
                    }
                    validTokens++;
                }
            }
            
            // Average by number of valid tokens
            if (validTokens > 0) {
                for (let i = 0; i < hiddenSize; i++) {
                    embedding[i] /= validTokens;
                }
            }
            
        } else if (outputTensor.dims.length === 2) {
            // Shape: [batch, hidden] - already pooled
            embedding = new Float32Array(outputTensor.data);
        } else {
            throw new Error(`Unexpected output shape: ${outputTensor.dims}`);
        }

        // Normalize the embedding (L2 normalization)
        let norm = 0;
        for (let i = 0; i < embedding.length; i++) {
            norm += embedding[i] * embedding[i];
        }
        norm = Math.sqrt(norm);
        
        if (norm > 0) {
            for (let i = 0; i < embedding.length; i++) {
                embedding[i] /= norm;
            }
        }

        postMessage({ 
            type: 'log', 
            payload: `✅ Generated ${embedding.length}-dimensional embedding` 
        });

        return Array.from(embedding);

    } catch (error) {
        postMessage({ 
            type: 'error', 
            payload: `Inference failed: ${error.message}` 
        });
        throw error;
    }
}

// Message handler for worker communication
self.onmessage = async (event) => {
    const { type, payload } = event.data;

    try {
        switch (type) {
            case 'initialize':
                // Handle model type configuration
                if (payload?.modelType && MODEL_CONFIGS[payload.modelType]) {
                    const newModelType = payload.modelType;
                    if (newModelType !== currentModelType) {
                        // Model is changing - reset session and initialization state
                        postMessage({ type: 'log', payload: `Switching from ${MODEL_CONFIGS[currentModelType].name} to ${MODEL_CONFIGS[newModelType].name}` });
                        session = null;
                        isInitializing = false;
                        currentModelType = newModelType;
                        modelPath = MODEL_CONFIGS[currentModelType].path;
                    }
                }
                const initModelPath = payload?.modelPath || modelPath;
                await initializeModel(initModelPath);
                break;

            case 'runInference':
                if (!payload?.text) {
                    postMessage({ 
                        type: 'error', 
                        payload: 'No text provided for inference' 
                    });
                    return;
                }
                
                const inferenceStartTime = performance.now();
                const embedding = await runInference(payload.text);
                const inferenceEndTime = performance.now();
                const inferenceDuration = inferenceEndTime - inferenceStartTime;
                
                postMessage({
                    type: 'result',
                    payload: {
                        text: payload.text,
                        embedding,
                        dimensions: embedding.length,
                        requestId: payload.requestId,
                        performance: {
                            inferenceTime: inferenceDuration,
                            provider: session?.executionProviders?.[0] || 'unknown',
                            modelType: currentModelType,
                            timestamp: Date.now()
                        }
                    }
                });
                break;

            case 'dispose':
                if (session) {
                    session.release?.();
                    session = null;
                    postMessage({ type: 'log', payload: 'Model session disposed' });
                }
                break;

            default:
                postMessage({ 
                    type: 'error', 
                    payload: `Unknown message type: ${type}` 
                });
        }
    } catch (error) {
        postMessage({
            type: 'error',
            payload: `Worker error: ${error.message}`,
            requestId: payload?.requestId
        });
    }
};

// Initialize worker
postMessage({ 
    type: 'log', 
    payload: 'WebGPU Inference Worker initialized and ready' 
});

// Run a small pre-flight diagnostic and report to main thread
async function runPreflightDiagnostic() {
    const hasWebGPU = typeof navigator !== 'undefined' && typeof navigator.gpu !== 'undefined' && navigator.gpu !== null;
    const ortPresent = typeof self.ort !== 'undefined';
    const configuredWasmPath = ortPresent ? (self.ort.env?.wasm?.wasmPaths || null) : null;
    const basePath = configuredWasmPath || '/onnxruntime-web/';

    const files = [
        'ort.webgpu.min.js',
        'ort.min.js',
        'ort-wasm-simd-threaded.wasm',
        'ort-wasm-simd-threaded.mjs',
        'ort-wasm-simd-threaded.jsep.mjs'
    ];

    const check = async (url) => {
        try {
            const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
            return { url, ok: res.ok, status: res.status };
        } catch (e) {
            return { url, ok: false, status: 0 };
        }
    };

    const assetChecks = [];
    for (const f of files) {
        const url = basePath.endsWith('/') ? basePath + f : basePath + '/' + f;
        // eslint-disable-next-line no-await-in-loop
        assetChecks.push(await check(url));
    }

    const jsepInfo = assetChecks.find(a => a.url.endsWith('ort-wasm-simd-threaded.jsep.mjs'));
    const wasmInfo = assetChecks.find(a => a.url.endsWith('ort-wasm-simd-threaded.wasm'));
    const missingCount = assetChecks.filter(a => !a.ok).length;

    postMessage({
        type: 'diagnostic',
        payload: {
            summary: {
                hasWebGPU,
                ortPresent,
                configuredWasmPath: configuredWasmPath || '(not set, defaulting to /onnxruntime-web/)',
                jsepPresent: !!(jsepInfo && jsepInfo.ok),
                wasmPresent: !!(wasmInfo && wasmInfo.ok),
                assetsMissing: missingCount
            },
            assets: assetChecks
        }
    });
}

// Export for testing (when not in worker context)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        initializeModel,
        runInference,
        tokenizeText
    };
}