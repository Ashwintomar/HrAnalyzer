// NVIDIA Reranker Service
// STRICTLY follows the provided reference (15-Sep-2025)
// Endpoint: https://ai.api.nvidia.com/v1/retrieval/nvidia/llama-3_2-nemoretriever-500m-rerank-v2/reranking
// Model: 'nvidia/llama-3.2-nemoretriever-500m-rerank-v2'

const fetch = require('node-fetch');

/**
 * Rerank documents with NVIDIA Reranker
 * Note: The reference provides input/output descriptions but not a detailed response shape.
 * We will forward the JSON and attempt to extract indices if present.
 *
 * @param {Object} params
 * @param {string} params.model - 'nvidia/llama-3.2-nemoretriever-500m-rerank-v2'
 * @param {string} params.query - The query text
 * @param {string[]} params.documents - Array of candidate document texts
 * @param {number} params.topN - Number of top passages to consider
 * @param {string} params.apiKey - NVIDIA API key (Bearer)
 * @returns {Promise<{indices: Array<{index:number, score:number}>}>}
 */
async function rerankWithNvidia({ model, query, documents, topN, apiKey }) {
  const invokeUrl = 'https://ai.api.nvidia.com/v1/retrieval/nvidia/llama-3_2-nemoretriever-500m-rerank-v2/reranking';

  const payload = {
    model,
    query: { text: query },
    passages: documents.map((text) => ({ text })),
  };

  const res = await fetch(invokeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`NVIDIA rerank error: ${res.status} ${txt}`);
  }

  const data = await res.json();
  // Attempt to extract ranking info without making undocumented assumptions.
  // If an array of results with indices & scores exists, map it.
  let mapped = [];
  if (Array.isArray(data?.results)) {
    mapped = data.results
      .map((r, i) => ({
        index: typeof r.index === 'number' ? r.index : i,
        score: typeof r.score === 'number' ? r.score : (typeof r.relevance_score === 'number' ? r.relevance_score : undefined),
      }))
      .filter((x) => typeof x.index === 'number' && typeof x.score === 'number');
  } else if (Array.isArray(data?.scores)) {
    // If scores correspond positionally to the passages
    mapped = data.scores
      .map((s, i) => ({ index: i, score: typeof s === 'number' ? s : undefined }))
      .filter((x) => typeof x.score === 'number');
  }
  return { indices: mapped };
}

module.exports = { rerankWithNvidia };