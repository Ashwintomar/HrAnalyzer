// Model Compatibility Checker Service
// Ensures consistent embedding models are used for jobs and candidates

const fs = require('fs');
const path = require('path');

class ModelCompatibilityChecker {
    constructor() {
        this.modelTracker = {};
        this.warnings = new Set();
    }

    /**
     * Tracks which model was used for embedding generation
     * @param {string} type - 'job' or 'candidate'
     * @param {string} modelName - Name of the model used
     * @param {string} itemId - ID of the job or candidate
     */
    trackModelUsage(type, modelName, itemId) {
        if (!this.modelTracker[type]) {
            this.modelTracker[type] = {};
        }
        this.modelTracker[type][itemId] = modelName;
    }

    /**
     * Checks for model mismatches between jobs and candidates and warns the user
     * @param {string} jobId - The job ID
     * @param {string[]} candidateIds - Array of candidate IDs to check
     * @returns {boolean} Whether models are compatible
     */
    checkModelCompatibility(jobId, candidateIds) {
        const jobModel = this.modelTracker.job && this.modelTracker.job[jobId];
        
        if (!jobModel) {
            console.warn(`⚠️ No model tracking data found for job ${jobId}`);
            return true; // Allow processing to continue
        }

        let hasWarning = false;
        const warningKey = `${jobId}-model-mismatch`;

        // Check each candidate against the job model
        for (const candidateId of candidateIds) {
            const candidateModel = this.modelTracker.candidate && this.modelTracker.candidate[candidateId];
            
            if (candidateModel && candidateModel !== jobModel) {
                if (!this.warnings.has(warningKey)) {
                    console.warn(`🚨 MODEL MISMATCH WARNING:`);
                    console.warn(`   Job ${jobId} uses model: ${jobModel}`);
                    console.warn(`   Candidate ${candidateId} uses model: ${candidateModel}`);
                    console.warn(`   Different embedding models may produce inaccurate similarity scores!`);
                    console.warn(`   For best results, use the same model for both jobs and candidates.`);
                    this.warnings.add(warningKey);
                    hasWarning = true;
                }
            }
        }

        return !hasWarning;
    }

    /**
     * Get model information for a specific job or candidate
     * @param {string} type - 'job' or 'candidate'
     * @param {string} id - ID of the job or candidate
     * @returns {string|null} Model name or null if not found
     */
    getModelForItem(type, id) {
        return this.modelTracker[type] && this.modelTracker[type][id];
    }

    /**
     * Clear all tracking data (useful for testing)
     */
    clearTracking() {
        this.modelTracker = {};
        this.warnings.clear();
    }

    /**
     * Get summary of tracked models
     * @returns {Object} Summary of models used
     */
    getModelSummary() {
        const summary = {
            jobs: Object.keys(this.modelTracker.job || {}).length,
            candidates: Object.keys(this.modelTracker.candidate || {}).length,
            jobModels: new Set(Object.values(this.modelTracker.job || {})),
            candidateModels: new Set(Object.values(this.modelTracker.candidate || {}))
        };
        return summary;
    }
}

// Export a singleton instance
module.exports = new ModelCompatibilityChecker();