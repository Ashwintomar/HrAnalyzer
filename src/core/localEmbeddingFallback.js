// Local Embedding Fallback
// Provides a resilient embedding pipeline with multiple tiers (reordered):
// 1. Primary: Local ONNXRuntime (if available) or hash fallback
// 2. Secondary: @huggingface/transformers JS pipeline (only if explicitly requested as secondary)
//    We intentionally invert priority to avoid repeated transformer downloads and cache clears.
//
// Exports a single async function getEmbeddingPipeline() returning an object:
//   { embed(texts: string[]|string): Promise<Float32Array[]> }
// The embed() method returns one embedding per input text.
// Each embedding will be normalized to unit length (L2 norm = 1) for cosine similarity.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const {
    ensureRuntimeDirectories,
    getModelsDir,
    getTransformersCacheDir,
    getTransformersCacheLock,
    getTransformersCacheMarker
} = require('./runtimePaths');

// Cache directory path for transformers
const TRANSFORMERS_CACHE_DIR = getTransformersCacheDir();
const CACHE_CLEARED_MARKER = getTransformersCacheMarker();
const CACHE_CLEARING_LOCK = getTransformersCacheLock();

let cachedPipeline = null;
let cachedType = null; // 'onnx-webgpu' | 'onnx-wasm' | 'hash' | 'transformers'
let loading = false;

// Model configurations for different BGE models
const MODEL_CONFIGS = {
    'bge-base': {
        url: 'https://huggingface.co/BAAI/bge-base-en-v1.5/resolve/main/onnx/model.onnx',
        huggingfaceId: 'BAAI/bge-base-en-v1.5',
        dimensions: 768,
        modelDir: 'bge-base-en-v1.5'
    },
    'bge-small': {
        url: 'https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/main/onnx/model.onnx',
        huggingfaceId: 'BAAI/bge-small-en-v1.5',
        dimensions: 384,
        modelDir: 'bge-small-en-v1.5'
    }
};

// Default model
const DEFAULT_MODEL = 'bge-base';

// Local storage paths
const MODELS_DIR = getModelsDir();

function ensureDir(p) {
	if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

ensureRuntimeDirectories();

async function downloadFile(url, dest, retries = 2) {
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000, headers: { 'User-Agent': 'hr-analyzer/1.0' } });
			fs.writeFileSync(dest, Buffer.from(response.data));
			return dest;
		} catch (err) {
			if (attempt === retries) throw err;
			await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
		}
	}
}

function clearTransformersCache() {
	try {
		// Check if cache was already cleared recently
		if (fs.existsSync(CACHE_CLEARED_MARKER)) {
			const markerStat = fs.statSync(CACHE_CLEARED_MARKER);
			const markerAge = Date.now() - markerStat.mtimeMs;
			if (markerAge < 30000) { // 30 seconds
				console.log('[Cache Clear] Cache was already cleared recently, skipping');
				return true;
			}
		}

		// Check if another process is currently clearing the cache
		if (fs.existsSync(CACHE_CLEARING_LOCK)) {
			const lockStat = fs.statSync(CACHE_CLEARING_LOCK);
			const lockAge = Date.now() - lockStat.mtimeMs;
			if (lockAge < 60000) { // 60 seconds
				console.log('[Cache Clear] Another process is clearing cache, waiting...');
				// Wait for the other process to finish
				for (let i = 0; i < 30; i++) {
					if (!fs.existsSync(CACHE_CLEARING_LOCK)) break;
					// Simple blocking wait (not ideal but works for this use case)
					const start = Date.now();
					while (Date.now() - start < 1000) { /* busy wait 1 second */ }
				}
				return true;
			} else {
				// Stale lock, remove it
				fs.unlinkSync(CACHE_CLEARING_LOCK);
			}
		}

		if (fs.existsSync(TRANSFORMERS_CACHE_DIR)) {
			// Create lock file to prevent other processes from clearing simultaneously
			fs.writeFileSync(CACHE_CLEARING_LOCK, 'clearing');
			
			console.log('[Cache Clear] Clearing transformers cache directory:', TRANSFORMERS_CACHE_DIR);
			fs.rmSync(TRANSFORMERS_CACHE_DIR, { recursive: true, force: true });
			console.log('[Cache Clear] Transformers cache cleared successfully');
			
			// Create marker file and remove lock
			fs.writeFileSync(CACHE_CLEARED_MARKER, 'cleared');
			fs.unlinkSync(CACHE_CLEARING_LOCK);
			return true;
		} else {
			console.log('[Cache Clear] Transformers cache directory does not exist');
			// Still create marker to prevent other processes from trying
			fs.writeFileSync(CACHE_CLEARED_MARKER, 'cleared');
			return false;
		}
	} catch (error) {
		console.error('[Cache Clear] Failed to clear transformers cache:', error.message);
		// Clean up lock file if it exists
		if (fs.existsSync(CACHE_CLEARING_LOCK)) {
			try { fs.unlinkSync(CACHE_CLEARING_LOCK); } catch (_) {}
		}
		return false;
	}
}

function l2Normalize(vec) {
	let sumSq = 0;
	for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
	const norm = Math.sqrt(sumSq) || 1;
	for (let i = 0; i < vec.length; i++) vec[i] /= norm;
	return vec;
}

// Tertiary hash-based embedding (deterministic, low quality)
// Hash-based embedding fallback (adjustable dimensions)
function hashEmbedding(text, dim = 768) {
	const vec = new Float32Array(dim);
	const cleaned = (text || '').toLowerCase();
	for (let i = 0; i < cleaned.length; i++) {
		const ch = cleaned.charCodeAt(i);
		const idx = ch % dim;
		vec[idx] += (ch % 7) - 3; // small variation
	}
	return l2Normalize(vec);
}

async function tryTransformers(modelType = DEFAULT_MODEL, retryAfterCacheClear = true) {
	try {
		const { pipeline } = require('@huggingface/transformers');
		const config = MODEL_CONFIGS[modelType] || MODEL_CONFIGS[DEFAULT_MODEL];
		const pl = await pipeline('feature-extraction', config.huggingfaceId, { device: 'cpu', dtype: 'fp32' });
		return {
			type: 'transformers',
			embed: async (inputs) => {
				const arr = Array.isArray(inputs) ? inputs : [inputs];
				const out = [];
				for (const chunk of arr) {
					const result = await pl([chunk], { pooling: 'mean', normalize: true });
					out.push(new Float32Array(result.data));
				}
				return out;
			}
		};
	} catch (err) {
		console.log('[Embedding Fallback] transformers pipeline unavailable:', err.message);
		
		// Only attempt cache clear for specific corruption errors and only once per session
		if (retryAfterCacheClear && (err.message.includes('Protobuf parsing failed') || err.message.includes('model.onnx failed'))) {
			console.log('[Embedding Fallback] Detected corrupted cache, attempting to clear and retry...');
			const cleared = clearTransformersCache();
			
			if (cleared) {
				console.log('[Embedding Fallback] Cache cleared, retrying transformers pipeline...');
				// Retry once after clearing cache
				try {
					return await tryTransformers(false); // Don't retry again if this fails
				} catch (retryErr) {
					console.log('[Embedding Fallback] Retry after cache clear also failed:', retryErr.message);
					return null;
				}
			} else {
				console.log('[Embedding Fallback] Cache clear was not performed, proceeding to fallback');
			}
		}
		
		return null;
	}
}

async function tryOnnxRuntime(modelType = DEFAULT_MODEL, preferWebGPU = false) {
	let ort;
	try {
		ort = require('onnxruntime-web');
	} catch (e) {
		console.log('[Embedding Fallback] onnxruntime-web not installed.');
		return null;
	}

	const config = MODEL_CONFIGS[modelType] || MODEL_CONFIGS[DEFAULT_MODEL];
	const LOCAL_MODEL_DIR = path.join(MODELS_DIR, config.modelDir);
	const LOCAL_MODEL_PATH = path.join(LOCAL_MODEL_DIR, 'model.onnx');
	
	ensureDir(LOCAL_MODEL_DIR);
	if (!fs.existsSync(LOCAL_MODEL_PATH)) {
		console.log(`[Embedding Fallback] Downloading ${modelType.toUpperCase()} ONNX model...`);
		try {
			await downloadFile(config.url, LOCAL_MODEL_PATH);
			console.log(`[Embedding Fallback] ${modelType.toUpperCase()} ONNX model downloaded.`);
		} catch (e) {
			console.log(`[Embedding Fallback] Failed to download ${modelType.toUpperCase()} ONNX model:`, e.message);
			return null; // allow hash fallback or transformers earlier
		}
	}

	// Minimal tokenizer (BERT WordPiece approximation using whitespace + char hashing)
	function tokenize(text, maxLen = 256) {
		const tokens = [];
		const words = text.toLowerCase().split(/\s+/).filter(Boolean);
		for (const w of words) {
			// simple hash to pretend token id
			let h = 0;
			for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
			tokens.push( (h % 30000) + 1 ); // reserve 0 for padding
			if (tokens.length >= maxLen - 2) break;
		}
		// Add [CLS]=101, [SEP]=102 style ids (approx)
		tokens.unshift(101);
		tokens.push(102);
		return tokens.slice(0, maxLen);
	}

	const sessionOptions = {};
	let executionProviders = [];
	let epType = 'onnx-wasm';
	try {
		if (ort.env.wasm) {
			// Check WebGPU availability and preference
			const webgpuAvailable = typeof ort.env.webgpu !== 'undefined';
			if (preferWebGPU && webgpuAvailable) {
				console.log('[Embedding Fallback] WebGPU preferred and available, using WebGPU execution provider');
				executionProviders = ['webgpu', 'wasm'];
				epType = 'onnx-webgpu';
			} else if (webgpuAvailable) {
				// WebGPU available but not specifically requested - still try it as fallback
				executionProviders = ['webgpu', 'wasm'];
				epType = 'onnx-webgpu';
			} else {
				console.log('[Embedding Fallback] WebGPU not available, using WASM');
				executionProviders = ['wasm'];
			}
		}
		
		if (executionProviders.length > 0) {
			sessionOptions.executionProviders = executionProviders;
		}
	} catch (_) { 
		console.log('[Embedding Fallback] Error configuring execution providers, using defaults');
	}

	let session;
	try {
		session = await ort.InferenceSession.create(LOCAL_MODEL_PATH, sessionOptions);
	} catch (e) {
		console.log('[Embedding Fallback] Failed to create ONNX session:', e.message);
		return null;
	}

	async function embed(inputs) {
		const arr = Array.isArray(inputs) ? inputs : [inputs];
		const outputs = [];
		for (const text of arr) {
			const tokenIds = tokenize(text);
			const seqLen = tokenIds.length;
			const inputIds = new BigInt64Array(256).fill(0n);
			for (let i = 0; i < tokenIds.length; i++) inputIds[i] = BigInt(tokenIds[i]);
			const attention = new BigInt64Array(256).fill(0n);
			for (let i = 0; i < tokenIds.length; i++) attention[i] = 1n;

			const tokenTypes = new BigInt64Array(256).fill(0n); // some models require token_type_ids
			const feeds = {
				'input_ids': new ort.Tensor('int64', inputIds, [1, 256]),
				'attention_mask': new ort.Tensor('int64', attention, [1, 256]),
				'token_type_ids': new ort.Tensor('int64', tokenTypes, [1, 256])
			};
			let result;
			try {
				result = await session.run(feeds);
			} catch (e) {
				console.log('[Embedding Fallback] ONNX inference failed:', e.message);
				outputs.push(hashEmbedding(text));
				continue;
			}
			// Heuristic: pick first output
			const firstKey = Object.keys(result)[0];
			const tensor = result[firstKey];
			const data = tensor.data; // Float32Array or TypedArray
			// Mean pooling across sequence dimension if needed
			let pooled;
			if (tensor.dims.length === 3) { // [1, seq, dim]
				const [b, s, d] = tensor.dims;
				pooled = new Float32Array(d);
				for (let i = 0; i < s; i++) {
					const att = attention[i];
					if (!att) continue;
					for (let j = 0; j < d; j++) {
						pooled[j] += data[i * d + j];
					}
				}
				// divide by number of attention positions
				let denom = 0; for (let i = 0; i < s; i++) if (attention[i]) denom++;
				denom = denom || 1;
				for (let j = 0; j < pooled.length; j++) pooled[j] /= denom;
			} else if (tensor.dims.length === 2) { // [1, dim]
				pooled = new Float32Array(data);
			} else {
				pooled = hashEmbedding(text); // unexpected shape
			}
			outputs.push(l2Normalize(pooled));
		}
		return outputs;
	}

	return { type: epType, embed };
}

async function getEmbeddingPipeline({ allowTransformersSecondary = false, preferWebGPU = false, modelType = DEFAULT_MODEL } = {}) {
	// Strict guard: if global config says online, prevent using local fallback
	try {
		const { getEmbeddingMode } = require('./embeddingConfig');
		if (getEmbeddingMode && getEmbeddingMode() === 'online') {
			throw new Error('[LocalEmbeddingFallback] Local pipeline requested while in online mode. This is disabled in strict mode.');
		}
	} catch (_) { /* ignore if config not available during module init */ }

	if (cachedPipeline) return cachedPipeline;
	if (loading) {
		while (loading && !cachedPipeline) {
			await new Promise(r => setTimeout(r, 50));
		}
		return cachedPipeline;
	}
	loading = true;
	
	// Get current model from embedding configuration if available
	let currentModel = modelType;
	try {
		const { getEmbeddingModel } = require('./embeddingConfig');
		const configModel = getEmbeddingModel();
		if (configModel && MODEL_CONFIGS[configModel]) {
			currentModel = configModel;
		}
	} catch (e) {
		// Fall back to passed modelType if embedding config not available
	}
	
	const config = MODEL_CONFIGS[currentModel] || MODEL_CONFIGS[DEFAULT_MODEL];
	
	// 1. Try ONNX first now
	const ortPipe = await tryOnnxRuntime(currentModel, preferWebGPU);
	if (ortPipe) { cachedPipeline = ortPipe.embed; cachedType = ortPipe.type; loading = false; return cachedPipeline; }
	// 2. Hash fallback if ONNX not available (using appropriate dimensions)
	cachedType = 'hash';
	cachedPipeline = async (inputs) => {
		const arr = Array.isArray(inputs) ? inputs : [inputs];
		return arr.map(t => hashEmbedding(t, config.dimensions));
	};
	// 3. Optionally attempt transformers as a secondary upgrade (non-blocking)
	if (allowTransformersSecondary) {
		try {
			const pipe = await tryTransformers(currentModel);
			if (pipe) {
				cachedPipeline = pipe.embed;
				cachedType = pipe.type;
			}
		} catch (_) { /* ignore transformer failure */ }
	}
	loading = false;
	return cachedPipeline;
}

function getEmbeddingProviderType() {
	return cachedType;
}

function clearEmbeddingCache() {
	cachedPipeline = null;
	cachedType = 'unknown';
	loading = false;
}

module.exports = { getEmbeddingPipeline, getEmbeddingProviderType, clearEmbeddingCache };

