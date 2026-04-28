// Reranker Manager
// Centralizes provider selection, key rotation with per-key timeout, and robust result mapping

const { getTimeoutSeconds, isKeyInTimeout, markKeyAsUsed, getApiKeyStats } = require('../embeddingConfig');
const { rerankWithJina } = require('./jinaRerankerService');
const { rerankWithNvidia } = require('./nvidiaRerankerService');
const { rerankWithCohere } = require('./cohereRerankerService');
const { rerankWithLangSearch } = require('./langsearchRerankerService');

// Independent rotation index for reranker use; timeout is shared via embeddingConfig
let rrIndex = 0;
// Internal last-use timestamps (ms) for reranker-specific pools
const rrLastUse = new Map();

async function pickKey(keys, timeoutSeconds) {
  if (!Array.isArray(keys) || keys.length === 0) throw new Error('No API keys configured for reranker');
  if (rrIndex >= keys.length || rrIndex < 0) rrIndex = 0;

  const timeoutMs = Math.max(0, (timeoutSeconds || getTimeoutSeconds() || 2) * 1000);

  let attempts = 0;
  let bestIdx = rrIndex;
  let bestRemain = Infinity;
  // Try to find a key that is free considering both embedding ledger and our internal reranker ledger
  while (attempts < keys.length) {
    const k = keys[rrIndex];
    const id = String(k).slice(-8);
    const last = rrLastUse.get(id) || 0;
    const now = Date.now();
    const delta = now - last;
    const freeByRr = delta >= timeoutMs;
    const freeByEmb = !isKeyInTimeout(k);
    if (freeByRr && freeByEmb) {
      bestIdx = rrIndex;
      bestRemain = 0;
      break;
    }
    const remainRr = Math.max(0, timeoutMs - delta);
    const remain = Math.max(remainRr, 0);
    if (remain < bestRemain) {
      bestRemain = remain;
      bestIdx = rrIndex;
    }
    rrIndex = (rrIndex + 1) % keys.length;
    attempts++;
  }

  const key = keys[bestIdx];
  // Wait until both ledgers allow the key (conservative)
  let waitMs = bestRemain;
  if (isKeyInTimeout(key)) {
    // We don't know exact remaining, wait full timeout window conservatively
    waitMs = Math.max(waitMs, timeoutMs);
  }
  if (waitMs > 0 && isFinite(waitMs)) {
    await new Promise((r) => setTimeout(r, waitMs));
  }
  // Update internal and shared ledgers
  try { markKeyAsUsed(key); } catch (_) {}
  rrLastUse.set(String(key).slice(-8), Date.now());
  rrIndex = (bestIdx + 1) % keys.length;
  return key;
}

/**
 * Apply a reranker to reorder candidates
 * @param {Object} opts
 * @param {string} opts.provider - 'jina' | 'nvidia' | 'cohere' | 'langsearch'
 * @param {string} opts.model
 * @param {string} opts.query
 * @param {string[]} opts.documents
 * @param {number} opts.topN
 * @param {string[]} opts.apiKeys - keys for the selected provider
 * @param {number} [opts.timeoutSeconds]
 * @returns {Promise<{order: number[], scores: number[]}>} - order is list of original indices sorted desc by score
 */
async function rerank({ provider, model, query, documents, topN, apiKeys, timeoutSeconds }) {
  const key = await pickKey(apiKeys, timeoutSeconds);
  let indices = [];

  if (provider === 'jina') {
    const out = await rerankWithJina({ model, query, documents, topN, apiKey: key });
    indices = out.indices || [];
  } else if (provider === 'nvidia') {
    const out = await rerankWithNvidia({ model, query, documents, topN, apiKey: key });
    indices = out.indices || [];
  } else if (provider === 'cohere') {
    const out = await rerankWithCohere({ model, query, documents, topN, apiKey: key });
    indices = out.indices || [];
  } else if (provider === 'langsearch') {
    const out = await rerankWithLangSearch({ model, query, documents, topN, apiKey: key, returnDocuments: false });
    indices = out.indices || [];
  } else {
    throw new Error(`Unsupported reranker provider: ${provider}`);
  }

  // Build order array from highest score to lowest, based on returned (index, score)
  const sorted = indices
    .slice()
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const order = sorted.map((x) => x.index);
  const scores = sorted.map((x) => x.score);
  return { order, scores };
}

module.exports = { rerank };