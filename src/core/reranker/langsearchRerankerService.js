// LangSearch Reranker Service
// STRICTLY follows the provided reference (15-Sep-2025)
// Endpoint: https://api.langsearch.com/v1/rerank

const fetch = require('node-fetch');

/**
 * Rerank documents with LangSearch
 * @param {Object} params
 * @param {string} params.model - 'langsearch-reranker-v1'
 * @param {string} params.query
 * @param {string[]} params.documents
 * @param {number} params.topN
 * @param {string} params.apiKey - LangSearch API key (Bearer)
 * @param {boolean} [params.returnDocuments=false]
 * @returns {Promise<{indices: Array<{index:number, score:number}>}>}
 */
async function rerankWithLangSearch({ model, query, documents, topN, apiKey, returnDocuments = false }) {
  const url = 'https://api.langsearch.com/v1/rerank';
  const payload = {
    model,
    query,
    top_n: Math.max(1, Math.min(topN || documents.length, documents.length)),
    return_documents: !!returnDocuments,
    documents,
  };

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
    throw new Error(`LangSearch rerank error: ${res.status} ${txt}`);
  }

  const data = await res.json();
  const arr = Array.isArray(data?.results) ? data.results : [];
  const mapped = arr
    .map((r) => ({ index: r.index, score: r.relevance_score }))
    .filter((x) => typeof x.index === 'number' && typeof x.score === 'number');
  return { indices: mapped };
}

module.exports = { rerankWithLangSearch };