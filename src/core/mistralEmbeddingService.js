// Mistral AI Embedding Service
// Provides an embedTexts function returning Float32Array[] matching local pipeline expectations.

const fetch = require('node-fetch');
const { nextApiKey, getEmbeddingModel, enforceRateLimit, validateEmbeddingInput } = require('./embeddingConfig');

// Mistral AI API configuration
const MISTRAL_API_BASE = 'https://api.mistral.ai/v1/embeddings';

// Mistral model configurations
const MISTRAL_MODELS = {
    'mistral-embed': {
        dimensions: 1024,
        maxTokens: 8192,
        type: 'text'
    }
};

async function embedTexts(texts, { workerId = 'main' } = {}) {
    // Validate input before processing
    const validatedInput = validateEmbeddingInput(texts);
    const arr = Array.isArray(validatedInput) ? validatedInput : [validatedInput];
    const model = getEmbeddingModel();
    
    // Validate model
    if (!MISTRAL_MODELS[model]) {
        throw new Error(`Unsupported Mistral model: ${model}`);
    }
    
    // Rate limit per worker
    await enforceRateLimit(workerId);
    
    const key = nextApiKey();
    
    try {
        const response = await fetch(MISTRAL_API_BASE, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${key}`
            },
            body: JSON.stringify({
                model: model,
                input: arr
            })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Mistral API error: ${response.status} ${errorText}`);
        }
        
        const data = await response.json();
        
        if (!data || !data.data) {
            throw new Error('No embeddings returned from Mistral API');
        }
        
        return data.data.map(item => {
            const embedding = item.embedding;
            return Float32Array.from(embedding);
        });
        
    } catch (err) {
        console.error('Mistral embedding error:', err);
        
        // Retry individually to salvage partial results
        const out = [];
        for (const text of arr) {
            try {
                await enforceRateLimit(workerId);
                const response = await fetch(MISTRAL_API_BASE, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${key}`
                    },
                    body: JSON.stringify({
                        model: model,
                        input: [text]
                    })
                });
                
                if (response.ok) {
                    const data = await response.json();
                    if (data && data.data && data.data[0]) {
                        out.push(Float32Array.from(data.data[0].embedding));
                    } else {
                        out.push(new Float32Array(MISTRAL_MODELS[model].dimensions));
                    }
                } else {
                    out.push(new Float32Array(MISTRAL_MODELS[model].dimensions));
                }
            } catch (_) {
                out.push(new Float32Array(MISTRAL_MODELS[model].dimensions));
            }
        }
        return out;
    }
}

module.exports = { 
    embedTexts,
    MISTRAL_MODELS
};