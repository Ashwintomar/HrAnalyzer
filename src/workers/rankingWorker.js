// Worker Thread dedicated to candidate ranking (job embedding + similarity search)
// Offloads heavy embedding generation and similarity computation from the main thread

const { parentPort } = require('worker_threads');
const { loadPipeline } = require('../core/pipelineManager');
const { setEmbeddingConfig, getEmbeddingProvider, getEmbeddingModel } = require('../core/embeddingConfig');
const AnalysisEngine = require('../modules/analyzer/analysisEngine');

// Note: This old feature extractor is no longer needed as we use the unified pipeline

// Mirror worker console logs to UI progress stream so users can see errors and details
try {
    const orig = { log: console.log, warn: console.warn, error: console.error };
    const forward = (level, args) => {
        try {
            const msg = args.map((a) => {
                if (a instanceof Error) return a.stack || a.message || String(a);
                if (typeof a === 'string') return a;
                try { return JSON.stringify(a); } catch (_) { return String(a); }
            }).join(' ');
            // Send as progress message; controller tags status as 'Ranking' and shows message
            parentPort.postMessage({ type: 'progress', status: `[${level.toUpperCase()}] ${msg}` });
        } catch (_) {
            /* ignore */
        }
    };
    console.log = (...args) => { forward('log', args); orig.log(...args); };
    console.warn = (...args) => { forward('warn', args); orig.warn(...args); };
    console.error = (...args) => { forward('error', args); orig.error(...args); };

    // Also capture unhandled errors within the worker
    process.on('unhandledRejection', (reason) => {
        const msg = reason && reason.stack ? reason.stack : String(reason);
        parentPort.postMessage({ type: 'progress', status: `[UNHANDLED_REJECTION] ${msg}` });
    });
    process.on('uncaughtException', (err) => {
        const msg = err && err.stack ? err.stack : String(err);
        parentPort.postMessage({ type: 'progress', status: `[UNCAUGHT_EXCEPTION] ${msg}` });
    });
} catch (_) { /* noop */ }

async function rank(jobData, limit, embeddingConfig, fetchLimit) {
    const engine = new AnalysisEngine();
    try {
        // ** CRITICAL FIX **: Set the worker's config to match the main thread's config for this task
        if (embeddingConfig) {
            setEmbeddingConfig(embeddingConfig);
        }

        parentPort.postMessage({ type: 'progress', status: 'Loading embedding pipeline...' });
        
        // Use the unified pipeline loader which respects the config
        const pipeline = await loadPipeline();
        parentPort.postMessage({ type: 'progress', status: 'Embedding provider: ' + getEmbeddingProvider() });
        
        if (jobData.selectedModel) {
            parentPort.postMessage({ type: 'progress', status: `Using model: ${jobData.selectedModel}` });
        }
        
        parentPort.postMessage({ type: 'progress', status: 'Generating job embedding...' });
        
        const modelName = getEmbeddingModel();
        const result = await engine.analyzeAndRank(jobData, async (texts, opts={}) => {
            // Force role 'job' => inputType 'query' for special NVIDIA model
            const out = await pipeline(texts, { ...opts, role: 'job', inputType: 'query' });
            return out;
        }, fetchLimit || limit || 50, modelName);
        // Optional: Apply reranker using same provider API keys as embeddings (when available)
        try {
            const rrCfg = jobData?.embeddingConfig?.reranker;
            if (rrCfg && rrCfg.enabled) {
        const { rerank } = require('../core/reranker/rerankerManager');
                const { getTimeoutSeconds } = require('../core/embeddingConfig');

                // Build query per references
                const jobTitle = jobData?.jobTitle || '';
                const keySkills = jobData?.keySkills || '';
                const baseQuery = [jobTitle, keySkills].filter(Boolean).join(' \n ');

                // Utilities for token-safe batching
                const approxTokens = (s) => Math.ceil(((s || '').length) / 4);
                const truncateByTokens = (s, maxToks) => {
                    if (!s) return s;
                    const maxChars = Math.max(0, Math.floor(maxToks * 4));
                    return s.length <= maxChars ? s : s.slice(0, maxChars);
                };

                // Start with current vector-ordered list
                let current = result.candidates.slice();

                const applyOne = async (provider, model, topN, apiKeys) => {
                    try {
                        const docsAll = current.map(c => (c?.content || '').toString());
                        const n = Math.max(1, Math.min(Number(topN || docsAll.length), docsAll.length));
                        const head = docsAll.slice(0, n);

                        if (!apiKeys || apiKeys.length === 0) {
                            parentPort.postMessage({ type: 'progress', status: `Reranker skipped (${provider} has no keys)` });
                            return;
                        }

                        // Defensive default models per provider if UI sent incompatible or empty model
                        let useModel = model;
                        const p = String(provider || '').toLowerCase();
                        if (p === 'nvidia') {
                            if (!useModel || !String(useModel).startsWith('nvidia/')) {
                                useModel = 'nvidia/llama-3.2-nemoretriever-500m-rerank-v2';
                                parentPort.postMessage({ type: 'progress', status: `Reranker (nvidia): overriding model to ${useModel}` });
                            }
                        } else if (p === 'cohere') {
                            if (!useModel) {
                                useModel = 'rerank-v3.5';
                                parentPort.postMessage({ type: 'progress', status: `Reranker (cohere): defaulting model to ${useModel}` });
                            }
                        } else if (p === 'jina') {
                            if (!useModel) {
                                useModel = 'jina-reranker-v2-base-multilingual';
                            }
                        } else if (p === 'langsearch') {
                            if (!useModel) {
                                useModel = 'langsearch-reranker-v1';
                            }
                        }

                        // Provider-specific batching and trimming rules
                        let batches = [];
                        let localQuery = baseQuery;
                        if (p === 'jina') {
                            // Query max 512 tokens
                            localQuery = truncateByTokens(baseQuery, 512);
                            // No explicit doc limit -> single batch with all head
                            batches = [{ start: 0, size: head.length, docs: head.slice() }];
                        } else if (p === 'langsearch') {
                            // Max 50 docs per request
                            const chunk = 50;
                            for (let i = 0; i < head.length; i += chunk) {
                                batches.push({ start: i, size: Math.min(chunk, head.length - i), docs: head.slice(i, i + chunk) });
                            }
                        } else if (p === 'nvidia') {
                            // Max 8192 tokens across all documents per request
                            let i = 0;
                            while (i < head.length) {
                                let tokSum = 0;
                                const docs = [];
                                let start = i;
                                while (i < head.length) {
                                    let d = head[i];
                                    let t = approxTokens(d);
                                    // If single doc exceeds limit, truncate it to close to limit
                                    if (t > 8192) {
                                        d = truncateByTokens(d, 8000);
                                        t = approxTokens(d);
                                    }
                                    if (tokSum + t > 8192 && docs.length > 0) break;
                                    docs.push(d);
                                    tokSum += t;
                                    i++;
                                }
                                if (docs.length === 0) {
                                    // Force at least one doc (truncated)
                                    let d = head[i];
                                    d = truncateByTokens(d, 8000);
                                    batches.push({ start: i, size: 1, docs: [d] });
                                    i++;
                                } else {
                                    batches.push({ start, size: docs.length, docs });
                                }
                            }
                        } else if (p === 'cohere') {
                            // Max ~4096 tokens per query-document pair: truncate each doc
                            const safeTok = 4090;
                            const trimmed = head.map(d => truncateByTokens(d, safeTok));
                            // Cohere recommends <= 1000 docs per request; our n is usually <= 100
                            batches = [{ start: 0, size: trimmed.length, docs: trimmed }];
                        } else {
                            // Default: single batch
                            batches = [{ start: 0, size: head.length, docs: head.slice() }];
                        }

                        // Execute batches and collect scores
                        const allPairs = [];
                        for (let bi = 0; bi < batches.length; bi++) {
                            const b = batches[bi];
                            const topNBatch = Math.min(b.size, n);
                            parentPort.postMessage({ type: 'progress', status: `Reranking (${provider}) batch ${bi + 1}/${batches.length} on ${b.size} docs...` });
                            try {
                                const { order, scores } = await rerank({
                                    provider,
                                    model: useModel,
                                    query: localQuery,
                                    documents: b.docs,
                                    topN: topNBatch,
                                    apiKeys,
                                    timeoutSeconds: getTimeoutSeconds(),
                                });
                                if (Array.isArray(order) && order.length > 0) {
                                    order.forEach((idx, i) => {
                                        if (typeof idx === 'number') {
                                            allPairs.push({ index: b.start + idx, score: typeof scores?.[i] === 'number' ? scores[i] : 0 });
                                        }
                                    });
                                } else {
                                    parentPort.postMessage({ type: 'progress', status: `Reranker (${provider}) batch ${bi + 1} returned no order; continuing` });
                                }
                            } catch (batchErr) {
                                const details = (batchErr && (batchErr.stack || batchErr.message)) ? (batchErr.stack || batchErr.message) : String(batchErr);
                                const clipped = details.length > 1000 ? details.slice(0, 1000) + ' ...[truncated]' : details;
                                parentPort.postMessage({ type: 'progress', status: `Reranker (${provider}) batch ${bi + 1} failed: ${clipped}` });
                                continue; // try next batch
                            }
                        }

                        if (allPairs.length === 0) {
                            parentPort.postMessage({ type: 'progress', status: `Reranker (${provider}) returned no combined results; keeping previous order` });
                            return;
                        }

                        // Merge scores and build global order
                        // If the same index appears multiple times (shouldn't), keep the max score
                        const bestByIndex = new Map();
                        allPairs.forEach(p => {
                            const prev = bestByIndex.get(p.index);
                            if (!prev || p.score > prev.score) bestByIndex.set(p.index, p);
                        });
                        const merged = Array.from(bestByIndex.values())
                            .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
                        const order = merged.map(x => x.index);
                        const scores = merged.map(x => x.score);

                        const tail = current.slice(n);
                        const reorderedHead = [];
                        const headArr = current.slice(0, n);
                        const used = new Set();
                        order.forEach((gIdx, i) => {
                            const localIdx = gIdx; // gIdx is already within 0..n-1 relative to head
                            if (typeof localIdx === 'number' && headArr[localIdx]) {
                                const c = headArr[localIdx];
                                c.rerank_score = typeof scores?.[i] === 'number' ? scores[i] : undefined;
                                reorderedHead.push(c);
                                used.add(localIdx);
                            }
                        });
                        for (let i = 0; i < headArr.length; i++) if (!used.has(i)) reorderedHead.push(headArr[i]);
                        current = [...reorderedHead, ...tail];
                        parentPort.postMessage({ type: 'progress', status: `Reranker (${provider}) applied over ${batches.length} batch(es). Combined results: ${merged.length}.` });
                    } catch (e) {
                        const details = (e && (e.stack || e.message)) ? (e.stack || e.message) : String(e);
                        const clipped = details.length > 2000 ? details.slice(0, 2000) + ' ...[truncated]' : details;
                        parentPort.postMessage({ type: 'progress', status: `Reranker (${provider}) failed: ${clipped}` });
                        // Continue to next step
                    }
                };

                if (rrCfg.multi && Array.isArray(rrCfg.steps) && rrCfg.steps.length > 0) {
                    const stepsArr = rrCfg.steps.slice();
                    for (let i = 0; i < stepsArr.length; i++) {
                        const step = stepsArr[i] || {};
                        const p = String(step.provider || '').toLowerCase();
                        const k = Array.isArray(step.apiKeys) ? step.apiKeys.length : 0;
                        parentPort.postMessage({ type: 'progress', status: `Rerank step ${i+1}/${stepsArr.length}: provider=${p || 'unknown'}, model=${step.model || ''}, topN=${step.topN || ''}, keys=${k}` });
                        if (!['jina','nvidia','cohere','langsearch'].includes(p)) {
                            parentPort.postMessage({ type: 'progress', status: `Reranker provider '${p}' unsupported; skipping step` });
                            continue;
                        }
                        await applyOne(p, step.model, step.topN, step.apiKeys);
                    }
                } else {
                    const provider = String(rrCfg.provider || '').toLowerCase();
                    const k = Array.isArray(rrCfg.apiKeys) ? rrCfg.apiKeys.length : 0;
                    parentPort.postMessage({ type: 'progress', status: `Rerank single step: provider=${provider || 'unknown'}, model=${rrCfg.model || ''}, topN=${rrCfg.topN || ''}, keys=${k}` });
                    if (!['jina','nvidia','cohere','langsearch'].includes(provider)) {
                        parentPort.postMessage({ type: 'progress', status: `Reranker provider '${provider}' unsupported; skipping` });
                    } else {
                        await applyOne(provider, rrCfg.model, rrCfg.topN, rrCfg.apiKeys);
                    }
                }

                // Trim to display limit before persisting
                const displayLimit = limit || 50;
                current = current.slice(0, displayLimit);
                // Update rank_position sequentially and persist
                current.forEach((c, i) => { c.rank_position = i + 1; });
                try {
                    const db = engine.db;
                    const upd = db.prepare('UPDATE Rankings SET rank_position = @pos WHERE job_id = @job AND candidate_id = @cid');
                    current.forEach((c, i) => upd.run({ pos: i + 1, job: result.jobId, cid: c.candidate_id }));
                    result.candidates = current;
                    parentPort.postMessage({ type: 'progress', status: `Reranking pipeline applied` });
                } catch (dbErr) {
                    parentPort.postMessage({ type: 'progress', status: `Rerank DB update failed: ${dbErr.message}` });
                }
            }
        } catch (rrError) {
            const details = (rrError && (rrError.stack || rrError.message)) ? (rrError.stack || rrError.message) : String(rrError);
            // Truncate excessively long details to avoid overwhelming UI
            const clipped = details.length > 4000 ? details.slice(0, 4000) + ' ...[truncated]' : details;
            parentPort.postMessage({ type: 'progress', status: `Reranking error: ${clipped}` });
        }
        // Always ensure final result is trimmed to display limit
        try {
            const displayLimit = limit || 50;
            if (Array.isArray(result?.candidates) && result.candidates.length > displayLimit) {
                result.candidates = result.candidates.slice(0, displayLimit);
            }
        } catch (_) { /* ignore */ }
        parentPort.postMessage({ type: 'complete', success: true, result });
    } catch (error) {
        console.error('Rank function error:', error);
        parentPort.postMessage({ type: 'complete', success: false, error: error.message });
    } finally {
        try { engine.close(); } catch (e) { /* ignore */ }
    }
}

parentPort.on('message', async (msg) => {
    if (msg.type === 'rank') {
        rank(msg.jobData, msg.limit, msg.embeddingConfig, msg.fetchLimit);
    }
});

parentPort.postMessage({ type: 'ready' });