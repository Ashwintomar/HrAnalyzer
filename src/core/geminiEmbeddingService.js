// Gemini Embedding Service using @google/genai (latest SDK)
// Provides an embedTexts function returning Float32Array[] matching local pipeline expectations.

const { GoogleGenAI } = require('@google/genai');
const { nextApiKey, getEmbeddingModel, getEmbeddingDimensions, enforceRateLimit, validateEmbeddingInput } = require('./embeddingConfig');

async function embedTexts(texts, { workerId = 'main' } = {}) {
    // Validate input before processing
    const validatedInput = validateEmbeddingInput(texts);
    const arr = Array.isArray(validatedInput) ? validatedInput : [validatedInput];
    
    // Rate limit per worker
    await enforceRateLimit(workerId);
    const key = nextApiKey();
    const ai = new GoogleGenAI({ apiKey: key });
    
    // Use the model from configuration (should be 'gemini-embedding-001')
    const model = getEmbeddingModel();
    const dims = getEmbeddingDimensions();
    
    // Try batch when possible using `contents: string[]` per SDK; fall back to per-item if needed
    try {
        // Filter out empties first to minimize API calls
        const cleanTexts = arr.map(t => (t || '').trim());
        const mapIndex = cleanTexts.map((t, i) => ({ i, t }));

        // Helper to embed a single text with shape fallback
        const embedSingle = async (text) => {
            // First try the newer documented shape
            try {
                const resp = await ai.models.embedContent({
                    model,
                    contents: text,
                    config: { outputDimensionality: dims }
                });
                const vals = resp?.embedding?.values || resp?.embeddings?.[0]?.values;
                if (Array.isArray(vals) && vals.length) return Float32Array.from(vals);
                throw new Error('Invalid embedding values returned');
            } catch (e) {
                // Fallback: some SDK versions accept top-level outputDimensionality and `content`
                if (e && /requests\[\]|contents|Value must be a list/i.test(String(e.message || ''))) {
                    const resp2 = await ai.models.embedContent({
                        model,
                        content: text,
                        outputDimensionality: dims
                    });
                    const vals2 = resp2?.embedding?.values || resp2?.embeddings?.[0]?.values;
                    if (Array.isArray(vals2) && vals2.length) return Float32Array.from(vals2);
                }
                throw e;
            }
        };

        // If there's only one text, call the single form for clarity
        if (cleanTexts.length === 1) {
            const single = cleanTexts[0];
            if (!single) {
                return [new Float32Array(dims)];
            }
            const vec = await embedSingle(single);
            const hasNonZero = Array.from(vec).some(v => v !== 0);
            if (!hasNonZero) console.warn('Gemini returned all-zero embedding, this may indicate API issues');
            return [vec];
        }

        // Batch path: pass an array in `contents`
        try {
            const response = await ai.models.embedContent({
                model,
                contents: cleanTexts,
                config: { outputDimensionality: dims }
            });

            const embObjs = response?.embeddings;
            if (!Array.isArray(embObjs) || embObjs.length !== cleanTexts.length) {
                throw new Error('Batch embedding response size mismatch or invalid format');
            }

            const embeddings = embObjs.map(obj => {
                const values = obj?.values;
                if (!Array.isArray(values) || values.length === 0) return new Float32Array(dims);
                return Float32Array.from(values);
            });

            console.log(`Successfully generated ${embeddings.length} Gemini embeddings`);
            return embeddings;
        } catch (batchErr) {
            // If batch shape fails, fall back to per-item single calls (with shape fallback)
            console.warn('Batch call failed, falling back to per-item:', batchErr.message);
            const vecs = [];
            for (const t of cleanTexts) {
                if (!t) { vecs.push(new Float32Array(dims)); continue; }
                try {
                    const v = await embedSingle(t);
                    vecs.push(v);
                } catch (e) {
                    console.warn('Per-item after batch failure also failed, using zero vector:', e.message);
                    vecs.push(new Float32Array(dims));
                }
            }
            return vecs;
        }
    } catch (err) {
        console.error('Gemini embedding batch failed:', err.message);
        
        // Retry individually to salvage partial results
        const out = [];
        for (const t of arr) {
            try {
                if (!t || t.trim().length === 0) {
                    out.push(new Float32Array(dims));
                    continue;
                }
                
                await enforceRateLimit(workerId);
                let vec;
                try {
                    vec = await ai.models.embedContent({
                        model,
                        contents: t.trim(),
                        config: { outputDimensionality: dims }
                    });
                    const values = vec?.embedding?.values || vec?.embeddings?.[0]?.values;
                    if (Array.isArray(values)) {
                        const hasNonZero = values.some(val => val !== 0);
                        if (!hasNonZero) {
                            console.warn('Individual Gemini request returned all-zero embedding');
                        }
                        out.push(Float32Array.from(values));
                        continue;
                    }
                    throw new Error('Invalid values');
                } catch (shapeErr) {
                    // Try legacy shape
                    const r2 = await ai.models.embedContent({
                        model,
                        content: t.trim(),
                        outputDimensionality: dims
                    });
                    const values2 = r2?.embedding?.values || r2?.embeddings?.[0]?.values;
                    if (values2 && Array.isArray(values2)) {
                        const hasNonZero = values2.some(val => val !== 0);
                        if (!hasNonZero) {
                            console.warn('Individual Gemini request (legacy shape) returned all-zero embedding');
                        }
                        out.push(Float32Array.from(values2));
                    } else {
                        console.warn('Invalid response for individual text, using zero vector');
                        out.push(new Float32Array(dims));
                    }
                }
            } catch (individualError) {
                console.warn('Individual embedding failed:', individualError.message);
                out.push(new Float32Array(dims));
            }
        }
        
        return out;
    }
}

module.exports = { embedTexts };
