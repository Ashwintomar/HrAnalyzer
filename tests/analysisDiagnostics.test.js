const assert = require('assert');
const { computeOutlierThresholds } = require('../src/modules/analyzer/analysisDiagnostics');

function runTests() {
    console.log('Test: outlier thresholds use ascending quartiles');
    const thresholds = computeOutlierThresholds([
        { similarity_score: 0.99 },
        { similarity_score: 0.92 },
        { similarity_score: 0.85 },
        { similarity_score: 0.80 },
        { similarity_score: 0.77 },
        { similarity_score: 0.70 },
        { similarity_score: 0.62 },
        { similarity_score: 0.50 }
    ]);

    assert.ok(thresholds);
    assert.deepStrictEqual(thresholds.scores, [0.5, 0.62, 0.7, 0.77, 0.8, 0.85, 0.92, 0.99]);
    assert.ok(thresholds.q1 <= thresholds.q3);
    assert.ok(thresholds.iqr > 0);
    assert.ok(thresholds.upperThreshold > thresholds.q3);
    assert.ok(thresholds.lowerThreshold < thresholds.q1);

    console.log('✅ Analysis diagnostics tests passed');
}

runTests();
