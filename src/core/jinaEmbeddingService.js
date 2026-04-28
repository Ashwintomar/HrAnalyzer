// Jina AI Embedding Service
// Provides an embedTexts function returning Float32Array[] matching local pipeline expectations.

const fetch = require('node-fetch');
const { nextApiKey, getEmbeddingModel, enforceRateLimit, validateEmbeddingInput } = require('./embeddingConfig');

// Jina AI API configuration
const JINA_API_BASE = 'https://api.jina.ai/v1/embeddings';

// Jina model configurations
const JINA_MODELS = {
    'jina-embeddings-v3': {
        dimensions: 1024,
        maxTokens: 8192,
        type: 'text'
    },
    'jina-embeddings-v4': {
        dimensions: 2048,
        maxTokens: 8192,
        type: 'multimodal' // supports both text and images
    }
};

async function embedTexts(texts, { workerId = 'main' } = {}) {
    // Validate input before processing
    const validatedInput = validateEmbeddingInput(texts);
    const arr = Array.isArray(validatedInput) ? validatedInput : [validatedInput];
    const model = getEmbeddingModel();
    
    // Validate model
    if (!JINA_MODELS[model]) {
        throw new Error(`Unsupported Jina model: ${model}`);
    }
    
    // Rate limit per worker
    await enforceRateLimit(workerId);
    
    const key = nextApiKey();
    
    try {
        const response = await fetch(JINA_API_BASE, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${key}`
            },
            body: JSON.stringify({
                model: model,
                task: 'text-matching',
                input: arr
            })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Jina API error: ${response.status} ${errorText}`);
        }
        
        const data = await response.json();
        
        if (!data || !data.data) {
            throw new Error('No embeddings returned from Jina API');
        }
        
        return data.data.map(item => {
            const embedding = item.embedding;
            return Float32Array.from(embedding);
        });
        
    } catch (err) {
        console.error('Jina embedding error:', err);
        
        // Retry individually to salvage partial results
        const out = [];
        for (const text of arr) {
            try {
                await enforceRateLimit(workerId);
                const response = await fetch(JINA_API_BASE, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${key}`
                    },
                    body: JSON.stringify({
                        model: model,
                        task: 'text-matching',
                        input: [text]
                    })
                });
                
                if (response.ok) {
                    const data = await response.json();
                    if (data && data.data && data.data[0]) {
                        out.push(Float32Array.from(data.data[0].embedding));
                    } else {
                        out.push(new Float32Array(JINA_MODELS[model].dimensions));
                    }
                } else {
                    out.push(new Float32Array(JINA_MODELS[model].dimensions));
                }
            } catch (_) {
                out.push(new Float32Array(JINA_MODELS[model].dimensions));
            }
        }
        return out;
    }
}

module.exports = { 
    embedTexts,
    JINA_MODELS
};