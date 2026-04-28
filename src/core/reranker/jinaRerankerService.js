// Jina Reranker Service
// STRICTLY follows the provided reference (15-Sep-2025)
// Endpoint: https://api.jina.ai/v1/rerank
// Model example: 'jina-reranker-v2-base-multilingual'

const fetch = require('node-fetch');

/**
 * Rerank documents with Jina AI
 * @param {Object} params
 * @param {string} params.model - e.g., 'jina-reranker-v2-base-multilingual'
 * @param {string} params.query - The query text
 * @param {string[]} params.documents - Array of candidate document texts
 * @param {number} params.topN - Number of top documents to return
 * @param {string} params.apiKey - Jina API key (Bearer)
 * @returns {Promise<{indices: Array<{index:number, score:number}>}>}
 */
async function rerankWithJina({ model, query, documents, topN, apiKey }) {
  const body = {
    model,
    query,
    top_n: Math.max(1, Math.min(topN || documents.length, documents.length)),
    documents,
    return_documents: false,
  };

  const res = await fetch('https://api.jina.ai/v1/rerank', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Jina rerank error: ${res.status} ${txt}`);
  }

  const data = await res.json();
  // Robust extraction without assuming undocumented fields:
  // Prefer data.results -> [{index, relevance_score}] pattern, else try data.data
  const arr = Array.isArray(data?.results) ? data.results : (Array.isArray(data?.data) ? data.data : []);
  const mapped = arr
    .map((r) => ({
      index: typeof r.index === 'number' ? r.index : (typeof r?.document_index === 'number' ? r.document_index : undefined),
      score: (typeof r.relevance_score === 'number' ? r.relevance_score : (typeof r.score === 'number' ? r.score : undefined)),
    }))
    .filter((x) => typeof x.index === 'number' && typeof x.score === 'number');

  return { indices: mapped };
}

module.exports = { rerankWithJina };