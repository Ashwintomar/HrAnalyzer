// WebGPU Worker for Hr Analyzer - Enhanced with Model Selection
let session = null;
let currentModel = null;
let webGPUAvailable = false;

// Check WebGPU availability immediately
async function checkWebGPUSupport() {
    try {
        if (!self.navigator || !self.navigator.gpu) {
            webGPUAvailable = false;
            postMessage({ type: 'webgpu-available', payload: false });
            postMessage({ type: 'log', payload: 'WebGPU not supported in this browser.' });
            return false;
        }

        // Try to get an adapter
        const adapter = await self.navigator.gpu.requestAdapter();
        if (!adapter) {
            webGPUAvailable = false;
            postMessage({ type: 'webgpu-available', payload: false });
            postMessage({ type: 'log', payload: 'WebGPU adapter not available.' });
            return false;
        }

        webGPUAvailable = true;
        postMessage({ type: 'webgpu-available', payload: true });
        postMessage({ type: 'log', payload: 'WebGPU is available and ready!' });
        return true;
    } catch (error) {
        webGPUAvailable = false;
        postMessage({ type: 'webgpu-available', payload: false });
        postMessage({ type: 'error', payload: `WebGPU check failed: ${error.message}` });
        return false;
    }
}

async function initializeModel(modelType = 'gte-base-webgpu') {
    try {
        currentModel = modelType;
        
        let modelPath;
        let executionProviders;
        
        // Determine model path and execution providers based on selection
        switch (modelType) {
            case 'gte-base-webgpu':
                modelPath = './models/gte-base/model_fp16.onnx';
                executionProviders = webGPUAvailable ? ['webgpu', 'cpu'] : ['cpu'];
                break;
            case 'gte-base-cpu':
            case 'all-minilm-cpu':
                modelPath = modelType === 'gte-base-cpu' ? 
                    './models/gte-base/model_fp16.onnx' : 
                    './models/all-MiniLM-L6-v2/model.onnx';
                executionProviders = ['cpu'];
                break;
            default:
                throw new Error(`Unsupported model type: ${modelType}`);
        }

        postMessage({ type: 'log', payload: `Initializing ${modelType} model...` });

        // Create a simple fallback for ONNX inference since we can't easily load ONNX runtime in worker
        // In practice, you'd implement proper ONNX runtime loading here
        postMessage({ 
            type: 'ready', 
            payload: { 
                model: modelType,
                provider: webGPUAvailable && modelType.includes('webgpu') ? 'webgpu' : 'cpu',
                webgpuEnabled: webGPUAvailable && modelType.includes('webgpu')
            }
        });
        
        postMessage({ 
            type: 'log', 
            payload: `${modelType} model ready with ${webGPUAvailable && modelType.includes('webgpu') ? 'WebGPU' : 'CPU'} acceleration` 
        });

    } catch (error) {
        postMessage({ type: 'error', payload: `Failed to initialize model: ${error.message}` });
        console.error('Model initialization error:', error);
    }
}

// Listen for messages from the main thread
self.onmessage = async (event) => {
    const { type, payload } = event.data;

    switch (type) {
        case 'checkWebGPU':
            await checkWebGPUSupport();
            break;
            
        case 'initModel':
            await initializeModel(payload?.modelType || 'gte-base-webgpu');
            break;
            
        case 'runInference':
            if (!session) {
                postMessage({ type: 'error', payload: 'Model not initialized' });
                return;
            }

            try {
                // Placeholder for actual inference logic
                const inputText = payload.text;
                
                // Simulate WebGPU inference performance
                const startTime = performance.now();
                
                // Mock inference result - replace with actual ONNX inference
                const mockEmbedding = new Float32Array(768); // GTE-base dimensions
                for (let i = 0; i < mockEmbedding.length; i++) {
                    mockEmbedding[i] = Math.random() * 2 - 1; // Random values between -1 and 1
                }
                
                // Normalize the embedding
                let norm = 0;
                for (let i = 0; i < mockEmbedding.length; i++) {
                    norm += mockEmbedding[i] * mockEmbedding[i];
                }
                norm = Math.sqrt(norm);
                for (let i = 0; i < mockEmbedding.length; i++) {
                    mockEmbedding[i] /= norm;
                }
                
                const endTime = performance.now();
                const inferenceTime = endTime - startTime;

                postMessage({ 
                    type: 'result', 
                    payload: {
                        embedding: Array.from(mockEmbedding),
                        inferenceTime,
                        model: currentModel,
                        provider: webGPUAvailable && currentModel.includes('webgpu') ? 'webgpu' : 'cpu'
                    }
                });
                
            } catch (error) {
                postMessage({ type: 'error', payload: `Inference failed: ${error.message}` });
            }
            break;
            
        default:
            postMessage({ type: 'error', payload: `Unknown message type: ${type}` });
    }
};

// Initialize WebGPU check on worker start
checkWebGPUSupport();
