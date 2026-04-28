// Test WebGPU functionality and model selection
console.log('🧪 Testing WebGPU and Model Selection...');

// Test 1: Check if WebGPU is available
console.log('WebGPU available:', !!navigator.gpu);

// Test 2: Create and test inference worker
const worker = new Worker('./inference-worker.js');

worker.onmessage = (event) => {
    const { type, payload } = event.data;
    console.log(`[Worker ${type}]:`, payload);
    
    if (type === 'modelReady') {
        console.log('✅ WebGPU model ready! Provider:', payload.provider);
        
        // Test inference
        worker.postMessage({
            type: 'runInference',
            payload: {
                text: 'Senior Python Developer with FastAPI experience',
                requestId: 'test-1'
            }
        });
    }
    
    if (type === 'result') {
        console.log('✅ Inference result:', {
            dimensions: payload.dimensions,
            embedding: payload.embedding.slice(0, 5), // First 5 values
            text: payload.text
        });
        
        // Cleanup
        worker.postMessage({ type: 'dispose' });
        worker.terminate();
    }
    
    if (type === 'error') {
        console.error('❌ Worker error:', payload);
    }
};

worker.onerror = (error) => {
    console.error('❌ Worker script error:', error);
};

// Initialize model
worker.postMessage({
    type: 'initialize',
    payload: {
        modelPath: './models/gte-base/model_fp16.onnx'
    }
});

// Test model selection dropdowns
document.addEventListener('DOMContentLoaded', () => {
    const modelSelects = [
        'embedding-model-select',
        'bulk-ingest-model-select', 
        'recycle-model-select'
    ];
    
    modelSelects.forEach(selectId => {
        const select = document.getElementById(selectId);
        if (select) {
            console.log(`✅ Found model select: ${selectId}`);
            console.log(`Current value: ${select.value}`);
            
            // Test change event
            select.addEventListener('change', (e) => {
                console.log(`Model changed in ${selectId}: ${e.target.value}`);
            });
        } else {
            console.warn(`⚠️ Model select not found: ${selectId}`);
        }
    });
});

console.log('🔄 WebGPU test script loaded. Check console for results...');