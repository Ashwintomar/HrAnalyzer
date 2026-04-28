// Main API Router

const express = require('express');
const { getPipelineStatus, loadPipeline } = require('../core/pipelineManager');
const {
    setEmbeddingConfig,
    getEmbeddingMode,
    getApiKeys,
    getEmbeddingModel,
    getEmbeddingProvider,
    getEmbeddingConfig
} = require('../core/embeddingConfig');
const analyzerRoutes = require('../modules/analyzer/analyzerRoutes');
const scriptGeneratorRoutes = require('../modules/script-generator/scriptGeneratorRoutes');
const gmailWorkspaceRoutes = require('../modules/gmail-workspace/gmailWorkspaceRoutes');
const processingManager = require('../core/workerPool');
const jobStateStore = require('../core/jobStateStore');

module.exports = (io) => {
    const router = express.Router();

    // Core status route
    router.get('/status', (req, res) => {
        res.json({
            status: 'running',
            pipeline_loaded: getPipelineStatus(),
            embedding_mode: getEmbeddingMode(),
            embedding_model: getEmbeddingModel(),
            timestamp: new Date().toISOString()
        });
    });

    // Expose active processing state so clients can hydrate instantly
    router.get('/active-state', (req, res) => {
        res.json(processingManager.getGlobalState());
    });

    // Job state endpoints for reload-safe progress UI
    router.get('/jobs/:jobId', (req, res) => {
        const job = jobStateStore.getJob(req.params.jobId);
        if (!job) {
            return res.status(404).json({ success: false, error: 'Job not found' });
        }
        res.json({ success: true, job });
    });

    router.get('/jobs', (req, res) => {
        const { type, limit } = req.query;
        const jobs = jobStateStore.listJobs({ type, limit: limit ? parseInt(limit, 10) : undefined });
        res.json({ success: true, jobs });
    });

    router.post('/jobs/:jobId/attach-socket', (req, res) => {
        const { socketId } = req.body || {};
        if (!socketId) {
            return res.status(400).json({ success: false, error: 'socketId is required' });
        }
        const job = jobStateStore.registerSocket(req.params.jobId, socketId);
        if (!job) {
            return res.status(404).json({ success: false, error: 'Job not found' });
        }
        res.json({ success: true, job });
    });

    // Get embedding configuration (excluding full keys for security)
    router.get('/embedding-config', (req, res) => {
        const keys = getApiKeys();
        const { getTimeoutSeconds } = require('../core/embeddingConfig');
        const cfg = getEmbeddingConfig();
        res.json({
            mode: getEmbeddingMode(),
            model: getEmbeddingModel(),
            provider: getEmbeddingProvider(),
            apiKeyCount: keys.length,
            timeoutSeconds: getTimeoutSeconds(),
            sampleMaskedKeys: keys.slice(0,3).map(k => k ? k.substring(0,4)+'...'+k.slice(-4) : ''),
            embeddingDimensions: cfg.embeddingDimensions,
            embeddingConcurrency: cfg.embeddingConcurrency,
            lmStudio: cfg.lmStudio || {}
        });
    });

    // Set model selection for analysis
    router.post('/set-model', (req, res) => {
        try {
            const { modelType } = req.body;
            
            // Validate model type
            const validModels = ['bge-base-webgpu', 'bge-base-cpu', 'bge-small-cpu', 'gemini-online', 'lmstudio-local'];
            if (!validModels.includes(modelType)) {
                return res.status(400).json({
                    error: 'Invalid model type',
                    validModels
                });
            }
            
            // Set the embedding configuration based on model selection
            let embeddingMode, embeddingModel, embeddingProvider;
            switch (modelType) {
                case 'bge-base-webgpu':
                case 'bge-base-cpu':
                    embeddingMode = 'local';
                    embeddingModel = 'bge-base';
                    embeddingProvider = 'local';
                    break;
                case 'bge-small-cpu':
                    embeddingMode = 'local';
                    embeddingModel = 'bge-small';
                    embeddingProvider = 'local';
                    break;
                case 'gemini-online':
                    embeddingMode = 'online';
                    embeddingModel = 'gemini-embedding-001';
                    embeddingProvider = 'gemini';
                    break;
                case 'lmstudio-local': {
                    embeddingMode = 'local';
                    embeddingProvider = 'lmstudio';
                    const cfg = getEmbeddingConfig();
                    embeddingModel = cfg?.lmStudio?.model || cfg?.model || '';
                    if (!embeddingModel) {
                        return res.status(400).json({
                            error: 'LM Studio model not configured. Please select a model in settings first.'
                        });
                    }
                    break;
                }
            }
            
            setEmbeddingConfig({ mode: embeddingMode, model: embeddingModel, provider: embeddingProvider });
            
            res.json({
                success: true,
                modelType,
                embeddingMode,
                embeddingModel,
                embeddingProvider,
                message: `Model switched to ${modelType}`
            });
            
        } catch (error) {
            console.error('Error setting model:', error);
            res.status(500).json({
                error: 'Failed to set model',
                message: error.message
            });
        }
    });

    // Update embedding config
    router.post('/embedding-config', (req, res) => {
        try {
            const {
                mode,
                apiKeys,
                model,
                provider,
                timeoutSeconds,
                embeddingConcurrency,
                embeddingDimensions,
                lmStudioBaseUrl,
                lmStudioModel,
                lmStudioDimensions
            } = req.body || {};
            setEmbeddingConfig({
                mode,
                apiKeys,
                model,
                provider,
                timeoutSeconds,
                embeddingConcurrency,
                embeddingDimensions,
                lmStudioBaseUrl,
                lmStudioModel,
                lmStudioDimensions
            });
            // Clear pipeline cache so it will reload with new config
            const { clearPipelineCache } = require('../core/pipelineManager');
            clearPipelineCache();
            const { getTimeoutSeconds } = require('../core/embeddingConfig');
            const cfg = getEmbeddingConfig();
            res.json({ 
                success: true, 
                mode: getEmbeddingMode(), 
                model: getEmbeddingModel(), 
                provider: getEmbeddingProvider(),
                timeoutSeconds: getTimeoutSeconds(),
                embeddingDimensions: cfg.embeddingDimensions,
                embeddingConcurrency: cfg.embeddingConcurrency,
                lmStudio: cfg.lmStudio || {}
            });
        } catch (e) {
            res.status(400).json({ success: false, error: e.message });
        }
    });

    router.get('/lmstudio/models', async (req, res) => {
        try {
            const { listModels } = require('../core/lmstudioEmbeddingService');
            const baseUrl = req.query.baseUrl;
            const models = await listModels({ baseUrl });
            res.json({ success: true, models });
        } catch (error) {
            console.error('Failed to fetch LM Studio models:', error.message);
            res.status(502).json({ success: false, error: error.message });
        }
    });

    // Force-load pipeline with current mode (useful after toggle)
    router.post('/embedding-load', async (req, res) => {
        try {
            await loadPipeline();
            res.json({ success: true, mode: getEmbeddingMode(), provider: getEmbeddingProvider(), model: getEmbeddingModel() });
        } catch (e) {
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // Plug in module routes
    router.use('/analyzer', analyzerRoutes(io));
    router.use('/script-generator', scriptGeneratorRoutes());
    router.use('/gmail-workspace', gmailWorkspaceRoutes(io));

    // Future modules will be added here:
    // router.use('/onboarding', onboardingRoutes(io));
    // router.use('/performance', performanceRoutes(io));
    // router.use('/payroll', payrollRoutes(io));

    return router;
};