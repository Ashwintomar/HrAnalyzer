function computeOutlierThresholds(similarities) {
    if (!Array.isArray(similarities) || similarities.length < 3) {
        return null;
    }

    const scores = similarities
        .map((entry) => Number(entry?.similarity_score))
        .filter((score) => Number.isFinite(score))
        .sort((a, b) => a - b);

    if (scores.length < 3) {
        return null;
    }

    const q1Index = Math.floor(scores.length * 0.25);
    const q3Index = Math.floor(scores.length * 0.75);
    const q1 = scores[q1Index];
    const q3 = scores[q3Index];
    const iqr = q3 - q1;

    return {
        scores,
        q1,
        q3,
        iqr,
        upperThreshold: q3 + (1.5 * iqr),
        lowerThreshold: q1 - (1.5 * iqr)
    };
}

module.exports = {
    computeOutlierThresholds
};
