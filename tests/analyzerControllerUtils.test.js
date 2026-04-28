const assert = require('assert');

const {
    WORKFLOW_TYPES,
    resolveWorkflowType,
    filterExportRows,
    calculateColumnWidths
} = require('../src/modules/analyzer/analyzerControllerUtils');

function runTests() {
    console.log('Test: explicit ingest-only workflow overrides truthy job data');
    const workflow = resolveWorkflowType({
        resumeData: [{ candidateId: 1 }],
        jobData: { embeddingConfig: { model: 'bge-base' } },
        mode: WORKFLOW_TYPES.INGEST_ONLY
    });
    assert.strictEqual(workflow, WORKFLOW_TYPES.INGEST_ONLY);

    console.log('Test: ranked export rows honor high-score exclusion threshold');
    const filtered = filterExportRows([
        { candidate_id: 1, similarity_score: 0.991 },
        { candidate_id: 2, similarity_score: 0.975 },
        { candidate_id: 3, similarity_score: 0.450 }
    ], {
        excludeHighScores: true,
        thresholdPercent: 98
    });
    assert.deepStrictEqual(filtered.map((row) => row.candidate_id), [2, 3]);

    console.log('Test: column widths remain finite for raw and meta sheets');
    const rawWidths = calculateColumnWidths([
        { candidate_id: 12, local_file_path: 'D:/resumes/alex_senior_engineer_resume.pdf' }
    ], ['candidate_id', 'local_file_path'], { maxWidth: 50, padding: 2 });
    const metaWidths = calculateColumnWidths([
        { Key: 'Description', Value: 'Longer metadata value for export sheet sizing' }
    ], ['Key', 'Value'], { maxWidth: 80, padding: 2 });

    [...rawWidths, ...metaWidths].forEach((entry) => {
        assert.ok(Number.isFinite(entry.wch));
        assert.ok(entry.wch > 0);
    });

    console.log('✅ Analyzer controller utility tests passed');
}

runTests();
