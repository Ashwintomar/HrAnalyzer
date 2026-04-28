// Gmail Workspace Controller
// Handles OAuth flow, email fetching, and resume processing

const gmailService = require('./gmailService');
const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const processingManager = require('../../core/workerPool');
const { getEmbeddingConfig } = require('../../core/embeddingConfig');
const jobStateStore = require('../../core/jobStateStore');
const { getResumesDir } = require('../../core/runtimePaths');

module.exports = (io) => {
    const controller = {};

    function resolveSocket(jobId, socket) {
        if (socket && socket.connected) return socket;
        if (!jobId) return socket;
        try {
            const job = jobStateStore.getJob(jobId);
            if (job?.socketId) {
                const nextSocket = io.sockets.sockets.get(job.socketId);
                if (nextSocket) return nextSocket;
            }
        } catch (err) {
            // Swallow lookup errors to avoid breaking progress updates
        }
        return socket;
    }

    function emitGmailProgress(jobId, socket, payload = {}, stageOverride = null, stats = null) {
        const targetSocket = resolveSocket(jobId, socket);
        if (targetSocket) {
            targetSocket.emit('gmail-progress', { ...payload, jobId });
        }
        if (!jobId) return;
        const progressValue = typeof payload.progress === 'number' ? Math.max(0, Math.min(100, payload.progress)) : undefined;
        jobStateStore.updateJob(jobId, {
            status: 'running',
            stage: stageOverride || payload.stage || 'processing',
            message: payload.message,
            progress: progressValue,
            stats
        });
        if (payload.message) {
            jobStateStore.appendLog(jobId, {
                stage: stageOverride || payload.stage || 'processing',
                message: payload.message,
                progress: progressValue
            });
        }
    }

    function completeGmailJob(jobId, payload = {}) {
        if (!jobId) return;
        jobStateStore.completeJob(jobId, {
            message: payload.message,
            stats: payload.stats,
            stage: payload.stage || 'complete',
            progress: 100
        });
    }

    function failGmailJob(jobId, error) {
        if (!jobId) return;
        jobStateStore.failJob(jobId, error);
    }

    /**
     * Initialize OAuth flow - returns auth URL
     */
    controller.initAuth = async (req, res) => {
        try {
            const { clientId, clientSecret, redirectUri } = req.body;

            if (!clientId || !clientSecret) {
                return res.status(400).json({
                    success: false,
                    error: 'Client ID and Client Secret are required'
                });
            }

            gmailService.initializeAuth({ clientId, clientSecret, redirectUri });
            const authUrl = gmailService.getAuthUrl();

            res.json({
                success: true,
                authUrl: authUrl
            });
        } catch (error) {
            console.error('Error initializing auth:', error);
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    };

    /**
     * OAuth2 callback handler - exchanges code for tokens
     */
    controller.oauth2Callback = async (req, res) => {
        try {
            const { code, clientId, clientSecret } = req.query;

            if (!code) {
                return res.status(400).send('Authorization code missing');
            }

            // Re-initialize with credentials
            if (clientId && clientSecret) {
                gmailService.initializeAuth({ clientId, clientSecret });
            }

            const tokens = await gmailService.getTokensFromCode(code);

            // Return tokens to frontend (will be stored in localStorage)
            res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Gmail Authorization Success</title>
                    <style>
                        body {
                            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            height: 100vh;
                            margin: 0;
                            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                            color: white;
                        }
                        .container {
                            text-align: center;
                            padding: 2rem;
                            background: rgba(255, 255, 255, 0.1);
                            border-radius: 16px;
                            backdrop-filter: blur(10px);
                        }
                        .success-icon {
                            font-size: 4rem;
                            margin-bottom: 1rem;
                        }
                        h1 { margin: 0 0 1rem 0; }
                        p { opacity: 0.9; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="success-icon">✅</div>
                        <h1>Authorization Successful!</h1>
                        <p>You can close this window and return to Hr Analyzer.</p>
                    </div>
                    <script>
                        console.log('✅ Gmail OAuth callback page loaded');
                        console.log('window.opener exists:', !!window.opener);
                        
                        // Store tokens in localStorage (works even if window.opener is lost)
                        try {
                            const tokens = ${JSON.stringify(tokens)};
                            console.log('📦 Storing tokens in localStorage');
                            localStorage.setItem('chunhr-gmail-tokens', JSON.stringify(tokens));
                            localStorage.setItem('chunhr-gmail-auth-complete', Date.now().toString());
                            console.log('✅ Tokens stored in localStorage');
                            
                            // Try postMessage as backup (if opener exists)
                            if (window.opener && !window.opener.closed) {
                                try {
                                    console.log('📤 Also sending postMessage to opener');
                                    window.opener.postMessage({
                                        type: 'gmail-auth-success',
                                        tokens: tokens
                                    }, '*');
                                } catch (e) {
                                    console.log('⚠️ postMessage failed (but localStorage worked):', e);
                                }
                            }
                            
                            // Close window after a short delay
                            setTimeout(() => {
                                console.log('👋 Closing popup window');
                                window.close();
                            }, 1000);
                        } catch (e) {
                            console.error('❌ Failed to store tokens:', e);
                        }
                    </script>
                </body>
                </html>
            `);
        } catch (error) {
            console.error('Error in OAuth callback:', error);
            res.status(500).send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Authorization Failed</title>
                </head>
                <body style="font-family: Inter, sans-serif; text-align: center; padding: 2rem;">
                    <h1>❌ Authorization Failed</h1>
                    <p>${error.message}</p>
                    <p>Please close this window and try again.</p>
                </body>
                </html>
            `);
        }
    };

    /**
     * Test Gmail connection
     */
    controller.testConnection = async (req, res) => {
        try {
            const { clientId, clientSecret, tokens } = req.body;

            if (!clientId || !clientSecret || !tokens) {
                return res.status(400).json({
                    success: false,
                    error: 'Missing credentials or tokens'
                });
            }

            gmailService.initializeAuth({ clientId, clientSecret }, tokens);
            const result = await gmailService.testConnection();

            res.json(result);
        } catch (error) {
            console.error('Error testing connection:', error);
            res.status(500).json({
                success: false,
                error: error.message
            });
        }
    };

    /**
     * Fetch and process resumes from Gmail
     */
    controller.fetchAndProcessResumes = async (req, res) => {
        const socketId = req.body.socketId;
        const socket = io.sockets.sockets.get(socketId);

        if (!socket) {
            return res.status(400).json({
                success: false,
                error: 'Invalid socket connection'
            });
        }

        let jobId = null;

        try {
            const { clientId, clientSecret, tokens, filters } = req.body;

            if (!clientId || !clientSecret || !tokens) {
                return res.status(400).json({
                    success: false,
                    error: 'Missing Gmail credentials or tokens'
                });
            }

            if (!filters) {
                return res.status(400).json({
                    success: false,
                    error: 'Filters are required'
                });
            }

            const jobRecord = jobStateStore.createJob({
                type: 'gmail-fetch',
                label: filters.textFilter || 'Gmail Resume Fetch',
                socketId,
                metadata: { filters }
            });
            jobId = jobRecord.id;

            // Initialize Gmail service
            gmailService.initializeAuth({ clientId, clientSecret }, tokens);

            // Send initial status
                emitGmailProgress(jobId, socket, {
                    stage: 'init',
                    message: 'Connecting to Gmail...',
                    progress: 5
                });

            // Fetch emails matching filters
                emitGmailProgress(jobId, socket, {
                    stage: 'fetching',
                    message: 'Searching for emails with PDF attachments...',
                    progress: 10
                });

            const emailIds = await gmailService.fetchEmails(filters, (progress) => {
                emitGmailProgress(jobId, socket, {
                    stage: 'fetching',
                    message: `Found ${progress.count} emails...`,
                    progress: 10 + Math.min(30, progress.count / 10)
                });
            });

            if (emailIds.length === 0) {
                const emptyStats = { emailsScanned: 0, pdfsFound: 0, resumesProcessed: 0 };
                emitGmailProgress(jobId, socket, {
                    stage: 'extracting',
                    message: 'No emails matched the filters',
                    progress: 100
                }, 'complete', emptyStats);
                completeGmailJob(jobId, { message: 'No emails matched the filters', stats: emptyStats });

                const emptySocket = resolveSocket(jobId, socket);
                emptySocket?.emit('gmail-complete', {
                    success: true,
                    jobId,
                    message: 'No emails found matching the filters',
                    stats: emptyStats
                });

                return res.json({
                    success: true,
                    jobId,
                    message: 'No emails found',
                    stats: emptyStats
                });
            }

            // Create download directory - use main resumes folder
            const downloadPath = getResumesDir();
            if (!fs.existsSync(downloadPath)) {
                fs.mkdirSync(downloadPath, { recursive: true });
            }

            // Initialize processing components BEFORE downloading
            const AnalysisEngine = require('../analyzer/analysisEngine');
            await processingManager.initializeWorkers(path.join(__dirname, '../../workers/resumeProcessor.js'));
            
            // Initialize analysis engine
            const analysisEngine = new AnalysisEngine();
            
            // Get current embedding configuration
            const embeddingConfig = getEmbeddingConfig();
            console.log(`Processing Gmail resumes with ${embeddingConfig.mode} embedding (${embeddingConfig.model})`);

            // Concurrency control for downloads
            const DOWNLOAD_CONCURRENCY = 5;
            const activeDownloads = new Set();
            const processingPromises = [];
            
            let emailsProcessed = 0;
            let pdfsFound = 0;
            let successCount = 0;
            let errorCount = 0;
            let duplicateCount = 0;

            // Helper to process a batch of PDFs
            const processPdfBatch = async (pdfs) => {
                if (!pdfs || pdfs.length === 0) return;
                pdfsFound += pdfs.length;
                
                const resumeData = [];
                for (const pdf of pdfs) {
                    try {
                        const fileName = path.basename(pdf.filepath);
                        const added = analysisEngine.addLocalPdfCandidate({ fileName, localFilePath: pdf.filepath });
                        if (added.duplicate) {
                            duplicateCount++;
                            // Clean up duplicate file to save space
                            try { fs.unlinkSync(pdf.filepath); } catch (e) {}
                            continue;
                        }
                        resumeData.push({
                            candidateId: added.candidateId,
                            resumeUrl: added.resumeUrl, // 'local:filename'
                            name: added.name,
                            email: null,
                            phone: null,
                            localFilePath: pdf.filepath
                        });
                    } catch (e) {
                        console.error('Failed to register Gmail PDF as candidate:', e);
                        errorCount++;
                    }
                }
                
                if (resumeData.length > 0) {
                    // Submit to processing manager and track the promise
                    // Use submitTasks (streaming) instead of processResumes (batch reset)
                    const p = processingManager.submitTasks(resumeData, (progress) => {
                        emitGmailProgress(jobId, socket, {
                            stage: 'processing',
                            message: `Processing: ${progress.message || '...'}`
                        });
                    }, embeddingConfig, 'GMAIL').then(results => {
                        const s = results.filter(r => r.success).length;
                        const e = results.filter(r => !r.success).length;
                        successCount += s;
                        errorCount += e;
                    }).catch(err => {
                        console.error('Batch processing failed:', err);
                        errorCount += resumeData.length;
                    });
                    processingPromises.push(p);
                }
            };

            // Parallel Download Loop
            for (const emailId of emailIds) {
                // Wait if too many active downloads
                while (activeDownloads.size >= DOWNLOAD_CONCURRENCY) {
                    await Promise.race(activeDownloads);
                }
                
                const p = gmailService.getEmailWithAttachments(emailId, downloadPath)
                    .then(pdfs => {
                        emailsProcessed++;
                        // Calculate progress: 10% to 90% range
                        const pct = Math.min(90, 10 + (emailsProcessed / emailIds.length) * 80);
                        emitGmailProgress(jobId, socket, {
                            stage: 'extracting',
                            message: `Scanned ${emailsProcessed}/${emailIds.length} emails...`,
                            progress: Math.round(pct)
                        });
                        return processPdfBatch(pdfs);
                    })
                    .catch(err => {
                        console.error(`Failed email ${emailId}`, err);
                        // Don't stop the whole process for one failed email
                    });
                
                // We need to attach the cleanup to the promise we add to the set
                const trackedPromise = p.finally(() => {
                    activeDownloads.delete(trackedPromise);
                });
                
                activeDownloads.add(trackedPromise);
            }

            // Wait for remaining downloads
            await Promise.all(activeDownloads);
            
            // Wait for all processing to complete
            if (processingPromises.length > 0) {
                emitGmailProgress(jobId, socket, {
                    stage: 'processing',
                    message: `Finalizing processing...`,
                    progress: 95
                });
                await Promise.all(processingPromises);
            }

            const finalStats = {
                emailsScanned: emailIds.length,
                pdfsFound: pdfsFound,
                resumesProcessed: successCount,
                errors: errorCount,
                downloadPath: downloadPath
            };

            emitGmailProgress(jobId, socket, {
                stage: 'complete',
                message: `Processed ${successCount} resumes with embeddings`,
                progress: 100
            }, 'complete', finalStats);
            completeGmailJob(jobId, { message: `Processed ${successCount} resumes with embeddings`, stats: finalStats });

            // Send completion
            const completionSocket = resolveSocket(jobId, socket);
            completionSocket?.emit('gmail-complete', {
                success: true,
                jobId,
                message: `Successfully processed ${successCount} resumes from Gmail with embeddings`,
                stats: finalStats
            });

            res.json({
                success: true,
                jobId,
                message: 'Resume processing completed',
                stats: finalStats
            });

        } catch (error) {
            console.error('Error in fetchAndProcessResumes:', error);
            
            failGmailJob(jobId, error);

            const errorSocket = resolveSocket(jobId, socket);
            errorSocket?.emit('gmail-error', {
                jobId,
                error: error.message
            });

            res.status(500).json({
                success: false,
                jobId,
                error: error.message
            });
        }
    };

    return controller;
};
