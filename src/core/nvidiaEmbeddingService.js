// NVIDIA NIM Embedding Service
// Provides an embedTexts function returning Float32Array[] matching local pipeline expectations.

const fetch = require('node-fetch');
const { nextApiKey, getEmbeddingModel, enforceRateLimit, validateEmbeddingInput } = require('./embeddingConfig');

// NVIDIA NIM API configuration
const NVIDIA_API_BASE = 'https://integrate.api.nvidia.com/v1/embeddings';

// NVIDIA NIM model configurations
const NVIDIA_MODELS = {
    'nvidia/nv-embedqa-e5-v5': {
        dimensions: 1024,
        maxTokens: 32768,
        type: 'text',
        requiresInputType: true
    },
    'baai/bge-m3': {
        dimensions: 1024,
        maxTokens: 8192,
        type: 'multilingual'
    },
    // Special model that requires input_type: 'query' (job) or 'passage' (candidate)
    'nvidia/llama-3.2-nv-embedqa-1b-v2': {
        dimensions: 1024,
        maxTokens: 32768,
        type: 'text',
        requiresInputType: true
    },
    // New NemoRetriever model - supports configurable dimensions and requires input_type
    'nvidia/llama-3.2-nemoretriever-300m-embed-v2': {
        dimensions: 2048, // Default to maximum, can be 384, 512, 768, 1024, or 2048
        maxTokens: 8192,
        type: 'text',
        requiresInputType: true,
        supportedDimensions: [384, 512, 768, 1024, 2048]
    }
};

// Heuristic to determine input_type for special NVIDIA model when no explicit context is provided
// Prefer explicit opts.inputType or opts.role. Heuristic is a last resort.
function inferInputTypeForTexts(texts) {
    try {
        const arr = Array.isArray(texts) ? texts : [texts];
        const avgLen = arr.reduce((s, t) => s + (t ? String(t).length : 0), 0) / Math.max(1, arr.length);
        const hasSkillsMarker = arr.some(t => typeof t === 'string' && t.includes(' - Required Skills: '));
        // Prefer 'query' if it looks like a compact job query or contains the skills marker
        if (hasSkillsMarker) return 'query';
        if (arr.length === 1 && avgLen <= 500) return 'query';
        // Otherwise assume longer resume-like content
        return 'passage';
    } catch (_) {
        return 'query';
    }
}

async function embedTexts(texts, { workerId = 'main', inputType: explicitInputType, role } = {}) {
    // Validate input before processing
    const validatedInput = validateEmbeddingInput(texts);
    const arr = Array.isArray(validatedInput) ? validatedInput : [validatedInput];
    const model = getEmbeddingModel();
    
    // Validate model
    if (!NVIDIA_MODELS[model]) {
        throw new Error(`Unsupported NVIDIA NIM model: ${model}`);
    }
    
    // Rate limit per worker
    await enforceRateLimit(workerId);
    
    const key = nextApiKey();
    
    try {
        // Special handling for models that require input_type
        const modelConfig = NVIDIA_MODELS[model];
        const needsInputType = modelConfig.requiresInputType === true;
        
        // Priority: explicit inputType > role mapping > heuristic
        let inputType = null;
        if (needsInputType) {
            if (explicitInputType === 'query' || explicitInputType === 'passage') {
                inputType = explicitInputType;
            } else if (role === 'job') {
                inputType = 'query';
            } else if (role === 'candidate') {
                inputType = 'passage';
            } else {
                inputType = inferInputTypeForTexts(arr);
            }

            if (inputType !== 'query' && inputType !== 'passage') {
                const fallback = role === 'job' ? 'query' : 'passage';
                console.warn(`[NVIDIA] Invalid or missing input_type '${inputType}' for model ${model}. Falling back to '${fallback}'.`);
                inputType = fallback;
            }

            console.log(`[NVIDIA] Model ${model} requires input_type. Using: ${inputType} (from ${explicitInputType ? 'explicit' : role ? 'role' : 'heuristic'})`);
        }

        const requestBody = {
            model: model,
            input: arr,
            encoding_format: 'float',
            truncate: 'NONE'
        };

        if (needsInputType) {
            requestBody.input_type = inputType;
        }

        const response = await fetch(NVIDIA_API_BASE, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${key}`
            },
            body: JSON.stringify(requestBody)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`NVIDIA NIM API error: ${response.status} ${errorText}`);
        }
        
        const data = await response.json();
        
        if (!data || !data.data) {
            throw new Error('No embeddings returned from NVIDIA NIM API');
        }
        
        return data.data.map(item => {
            const embedding = item.embedding;
            return Float32Array.from(embedding);
        });
        
    } catch (err) {
        console.error('NVIDIA NIM embedding error:', err);
        
        // Retry individually to salvage partial results
        const out = [];
        for (const text of arr) {
            try {
                await enforceRateLimit(workerId);

                const modelConfig = NVIDIA_MODELS[model];
                const needsInputType = modelConfig.requiresInputType === true;
                let retryInputType = null;
                if (needsInputType) {
                    if (explicitInputType === 'query' || explicitInputType === 'passage') {
                        retryInputType = explicitInputType;
                    } else if (role === 'job') {
                        retryInputType = 'query';
                    } else if (role === 'candidate') {
                        retryInputType = 'passage';
                    } else {
                        retryInputType = inferInputTypeForTexts(text);
                    }

                    if (retryInputType !== 'query' && retryInputType !== 'passage') {
                        const fallback = role === 'job' ? 'query' : 'passage';
                        console.warn(`[NVIDIA] Retry falling back to input_type '${fallback}' (got '${retryInputType}') for model ${model}.`);
                        retryInputType = fallback;
                    }
                }

                const retryRequestBody = {
                    model: model,
                    input: [text],
                    encoding_format: 'float',
                    truncate: 'NONE'
                };

                if (needsInputType) {
                    retryRequestBody.input_type = retryInputType;
                }
                
                const response = await fetch(NVIDIA_API_BASE, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${key}`
                    },
                    body: JSON.stringify(retryRequestBody)
                });
                
                if (response.ok) {
                    const data = await response.json();
                    if (data && data.data && data.data[0]) {
                        out.push(Float32Array.from(data.data[0].embedding));
                    } else {
                        out.push(new Float32Array(NVIDIA_MODELS[model].dimensions));
                    }
                } else {
                    out.push(new Float32Array(NVIDIA_MODELS[model].dimensions));
                }
            } catch (_) {
                out.push(new Float32Array(NVIDIA_MODELS[model].dimensions));
            }
        }
        return out;
    }
}

module.exports = { 
    embedTexts,
    NVIDIA_MODELS
};