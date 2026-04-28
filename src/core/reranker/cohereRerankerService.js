// Cohere Reranker Service
// STRICTLY follows the provided reference (15-Sep-2025)
// Usage sample in reference shows v2.rerank with response.results [{ index, relevance_score }]

const fetch = require('node-fetch');

/**
 * Rerank documents with Cohere (HTTP form compatible with reference)
 * Note: The reference uses SDK. We use HTTPS directly to avoid new deps.
 * Docs suggest endpoint: https://api.cohere.ai/v2/rerank
 * If this changes, users should switch to the official SDK.
 *
 * @param {Object} params
 * @param {string} params.model - e.g., 'rerank-v3.5'
 * @param {string} params.query
 * @param {string[]} params.documents
 * @param {number} params.topN
 * @param {string} params.apiKey - Cohere API key (Bearer)
 * @returns {Promise<{indices: Array<{index:number, score:number}>}>}
 */
async function rerankWithCohere({ model, query, documents, topN, apiKey }) {
  const url = 'https://api.cohere.ai/v2/rerank';
  // Cohere v2 HTTP API expects 'top_n' (snake_case), not 'topN'
  const payload = { model, query, documents, top_n: topN };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Cohere rerank error: ${res.status} ${txt}`);
  }
  const data = await res.json();
  const arr = Array.isArray(data?.results) ? data.results : [];
  const mapped = arr
    .map((r) => ({ index: r.index, score: r.relevance_score }))
    .filter((x) => typeof x.index === 'number' && typeof x.score === 'number');
  return { indices: mapped };
}

module.exports = { rerankWithCohere };