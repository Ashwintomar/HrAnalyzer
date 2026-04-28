const DEFAULT_SCORE_FILTER_THRESHOLD = 98;

const WORKFLOW_TYPES = Object.freeze({
    INGEST_ONLY: 'ingest-only',
    RANK_ONLY: 'rank-only',
    INGEST_AND_RANK: 'ingest-and-rank'
});

function resolveWorkflowType({ resumeData, jobData, mode } = {}) {
    if (mode && Object.values(WORKFLOW_TYPES).includes(mode)) {
        return mode;
    }

    const hasResumeData = Array.isArray(resumeData) ? resumeData.length > 0 : Boolean(resumeData);
    const hasJobData = Boolean(jobData);

    if (hasResumeData && !hasJobData) return WORKFLOW_TYPES.INGEST_ONLY;
    if (!hasResumeData && hasJobData) return WORKFLOW_TYPES.RANK_ONLY;
    if (hasResumeData && hasJobData) return WORKFLOW_TYPES.INGEST_AND_RANK;

    throw new Error('Invalid workflow parameters');
}

function normalizeThresholdPercent(value, fallback = DEFAULT_SCORE_FILTER_THRESHOLD) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return parsed;
}

function filterExportRows(rows, { excludeHighScores = false, thresholdPercent = DEFAULT_SCORE_FILTER_THRESHOLD } = {}) {
    if (!Array.isArray(rows)) return [];
    if (!excludeHighScores) return rows.slice();

    const threshold = normalizeThresholdPercent(thresholdPercent) / 100;
    return rows.filter((row) => {
        const score = Number(row?.similarity_score);
        return !Number.isFinite(score) || score < threshold;
    });
}

function calculateColumnWidths(rows, keys, { maxWidth = 50, padding = 2 } = {}) {
    const safeRows = Array.isArray(rows) ? rows : [];
    const safeKeys = Array.isArray(keys) ? keys : [];

    return safeKeys.map((key) => {
        const headerLength = String(key).length;
        const maxDataLength = safeRows.reduce((maxLength, row) => {
            const value = row == null ? undefined : row[key];
            const valueLength = value == null ? 0 : String(value).length;
            return Math.max(maxLength, valueLength);
        }, 0);

        return {
            wch: Math.min(maxWidth, Math.max(headerLength + padding, maxDataLength + padding))
        };
    });
}

module.exports = {
    DEFAULT_SCORE_FILTER_THRESHOLD,
    WORKFLOW_TYPES,
    resolveWorkflowType,
    normalizeThresholdPercent,
    filterExportRows,
    calculateColumnWidths
};
