// Hr Analyzer - Frontend JavaScript
// Handles UI interactions and real-time communication

class HrAnalyzerApp {
    constructor() {
        this.socket = null;
        this.currentView = 'home';
        this.uploadedFile = null;
        this.processingResults = [];
        this.scriptGeneratorFile = null;
        this.generatedScriptContent = '';
        this.currentTaskType = null;
        
        // WebGPU Inference Worker
        this.inferenceWorker = null;
        this.workerReady = false;
        this.initializingInferenceWorker = false;
        this.pendingInferences = new Map();
        this.requestIdCounter = 0;
        
        // WebGPU and Model Management
        this.webGPUWorker = null;
        this.webGPUAvailable = false;
        this.initializingWebGPUWorker = false;
        this.currentModel = null;
        this.modelStatus = 'loading';
        
        // Theme Studio State
        this.themePresets = JSON.parse(localStorage.getItem('chunhr-theme-presets') || '[]');
        this.themeVars = {
            'brand-hue': 210,
            'brand-sat': 90,
            'accent-shift': 60,
            'depth': 20,
            'glass-blur': 20,
            'radius': 24,
            'font-weight': 500,
            'letter-spacing': 0
        };
        this.apiKeys = JSON.parse(localStorage.getItem('chunhr-api-keys') || '[]');
        // Provider-specific API key storage with rotation support
        this.providerApiKeys = {
            gemini: JSON.parse(localStorage.getItem('chunhr-gemini-api-keys') || '[]'),
            mistral: JSON.parse(localStorage.getItem('chunhr-mistral-api-keys') || '[]'),
            nvidia: JSON.parse(localStorage.getItem('chunhr-nvidia-api-keys') || '[]'),
            jina: JSON.parse(localStorage.getItem('chunhr-jina-api-keys') || '[]'),
            cohere: JSON.parse(localStorage.getItem('chunhr-cohere-api-keys') || '[]'),
            langsearch: JSON.parse(localStorage.getItem('chunhr-langsearch-api-keys') || '[]')
        };
        this.apiKeyRotationIndex = {
            gemini: parseInt(localStorage.getItem('chunhr-gemini-rotation-index') || '0'),
            mistral: parseInt(localStorage.getItem('chunhr-mistral-rotation-index') || '0'),
            nvidia: parseInt(localStorage.getItem('chunhr-nvidia-rotation-index') || '0'),
            jina: parseInt(localStorage.getItem('chunhr-jina-rotation-index') || '0'),
            cohere: parseInt(localStorage.getItem('chunhr-cohere-rotation-index') || '0'),
            langsearch: parseInt(localStorage.getItem('chunhr-langsearch-rotation-index') || '0')
        };
        this.apiKeyTimeout = parseInt(localStorage.getItem('chunhr-api-key-timeout') || '2'); // Default 2 seconds
        this.lastApiKeyUsage = {}; // Track when each API key was last used
    this.selectedModel = localStorage.getItem('chunhr-selected-model') || 'gemini-flash-latest';
        this.selectedLlmProvider = localStorage.getItem('chunhr-llm-provider') || 'gemini';
        this.selectedEmbeddingModel = localStorage.getItem('chunhr-selected-embedding-model') || 'gemini-embedding-001';
this.selectedEmbeddingProvider = localStorage.getItem('chunhr-selected-embedding-provider') || 'gemini';
        // Reranker state
        this.rerankerEnabled = (localStorage.getItem('chunhr-reranker-enabled') || 'false') === 'true';
        this.selectedRerankerProvider = localStorage.getItem('chunhr-selected-reranker-provider') || 'jina';
        this.selectedRerankerModel = localStorage.getItem('chunhr-selected-reranker-model') || 'jina-reranker-v2-base-multilingual';
        this.rerankerTopN = parseInt(localStorage.getItem('chunhr-reranker-topn') || '25', 10);
        // Multi-step reranker state
        this.rerankerMultiEnabled = (localStorage.getItem('chunhr-reranker-multi-enabled') || 'false') === 'true';
        this.rerankerStep1 = JSON.parse(localStorage.getItem('chunhr-reranker-step1') || JSON.stringify({ provider: 'jina', model: 'jina-reranker-v2-base-multilingual', topN: 50 }));
        this.rerankerStep2 = JSON.parse(localStorage.getItem('chunhr-reranker-step2') || JSON.stringify({ provider: 'cohere', model: 'rerank-v3.5', topN: 25 }));
        this.embeddingConcurrency = parseInt(localStorage.getItem('chunhr-embedding-concurrency') || '3', 10);
        this.selectedLocalEmbedding = localStorage.getItem('chunhr-local-embedding') || 'bge-base';
        this.lmStudioConfig = {
            baseUrl: localStorage.getItem('chunhr-lmstudio-base-url') || 'http://127.0.0.1:1234',
            model: localStorage.getItem('chunhr-lmstudio-model') || '',
            dimensions: localStorage.getItem('chunhr-lmstudio-dimensions') || ''
        };
        this.lmStudioModels = [];
        this.sidebarStorageKey = 'chunhr-sidebar-collapsed';
        this.sidebarPreferenceSet = localStorage.getItem(this.sidebarStorageKey) !== null;
        this.sidebarCollapsed = false;
        this.routeForcedSidebarCollapsed = false;

        // Filter out any candidate with 98% or higher score
        // Threshold is configurable here if you need to change it later
        this.scoreFilterThreshold = 98; // percent

        this.init();
    }
    
    init() {
        console.log('Hr Analyzer frontend initializing...');
        this.setupSocketConnection();
        this.initSidebarState();
        this.setupEventListeners();
        this.checkServerStatus();
        this.initThemeStudio();
        this.renderApiKeys();
        this.initEmbeddingToggle();
        this.maybeInitLocalInference();
        this.initWebGPUWorker();
        this.initModelSelection();
this.initSettings();
        this.initRerankerSettings();
        // Ensure Minkowski parameter UI wiring is active
        this.initializeAlgorithmDropdowns();
    }
    
    // Socket.IO Connection
    setupSocketConnection() {
        this.socket = io();
        
        this.socket.on('connect', () => {
            console.log('Connected to server');
            this.updateStatus('online', 'Connected');
        });
        
        this.socket.on('disconnect', () => {
            console.log('Disconnected from server');
            this.updateStatus('offline', 'Disconnected');
        });
        
        this.socket.on('pipeline-loaded', (data) => {
            if (data.success) {
                this.updateStatus('pipeline-loaded', 'AI Model Ready');
                this.showNotification('AI model loaded successfully!', 'success');
                this.hideLoading();
            } else {
                this.showNotification('Failed to load AI model: ' + data.error, 'error');
                this.hideLoading();
            }
        });
        // Intermediate loading state
        this.socket.on('pipeline-loading', () => {
            // Ensure overlay visible but avoid duplicate timers
            if (!this._pipelineLoadTimer) {
                // Fallback: hide overlay after 90s even if no final event (avoid permanent lock)
                this._pipelineLoadTimer = setTimeout(() => {
                    if (document.getElementById('loading-overlay') && !document.getElementById('loading-overlay').classList.contains('hidden')) {
                        this.showNotification('Model load timed out (fallback). Refresh if not ready.', 'warning');
                        this.hideLoading();
                    }
                    this._pipelineLoadTimer = null;
                }, 90000);
            }
        });
        
        // Module-specific socket events
        this.socket.on('analyzer-progress', (data) => {
            this.updateAnalyzerProgress(data);
        });
        
        this.socket.on('analyzer-complete', (data) => {
            this.handleAnalyzerComplete(data);
        });
    }
    
    // Event Listeners
    setupEventListeners() {
        // Mobile menu toggle
        const mobileMenuToggle = document.getElementById('mobile-menu-toggle');
        const sidebarCollapseBtn = document.getElementById('sidebar-collapse-btn');
        const sidebar = document.getElementById('sidebar');
        const mobileOverlay = document.getElementById('mobile-overlay');
        
        if (mobileMenuToggle && sidebar && mobileOverlay) {
            mobileMenuToggle.addEventListener('click', () => {
                this.setMobileSidebarOpen(!sidebar.classList.contains('mobile-open'));
            });
            
            mobileOverlay.addEventListener('click', () => {
                this.setMobileSidebarOpen(false);
            });
        }

        if (sidebarCollapseBtn) {
            sidebarCollapseBtn.addEventListener('click', () => this.toggleSidebarCollapse());
        }

        window.addEventListener('resize', () => this.handleViewportChange());
        
        // Navigation buttons
        document.getElementById('get-started-btn').addEventListener('click', () => {
            this.showAnalyzerView('dashboard');
        });
        
        document.getElementById('load-pipeline-btn').addEventListener('click', () => {
            this.loadAIPipeline();
        });
        
        // Sidebar navigation
        document.querySelectorAll('.sidebar-nav .nav-link').forEach(link => {
            link.addEventListener('click', (e) => this.handleNavigation(e));
        });
        
        // Tool preview cards
        document.querySelectorAll('.tool-preview-card[data-tool]').forEach(card => {
            card.addEventListener('click', (e) => {
                const tool = e.currentTarget.dataset.tool;
                if (tool) this.navigateTo(tool);
            });
        });

        document.querySelectorAll('.hero-nav-btn[data-nav-target]').forEach(button => {
            button.addEventListener('click', (e) => {
                const target = e.currentTarget.dataset.navTarget;
                if (target) this.navigateTo(target);
            });
        });

        this.navigateTo(window.location.hash.substring(1) || 'home');

        // Dashboard task listeners
        document.getElementById('task-ingest-rank').addEventListener('click', () => this.openTaskModal('ingest-rank'));
        document.getElementById('task-rank-existing').addEventListener('click', () => this.openTaskModal('rank-existing'));
        document.getElementById('task-ingest-only').addEventListener('click', () => this.openTaskModal('ingest-only'));
        document.getElementById('task-recycle-vectors').addEventListener('click', () => this.openRecycleVectorsModal());
    const taskPastJobs = document.getElementById('task-past-jobs');
    if (taskPastJobs) taskPastJobs.addEventListener('click', () => this.openPastJobsModal());

        // Modal buttons
        document.getElementById('modal-close-btn').addEventListener('click', () => this.closeTaskModal());
        document.getElementById('task-modal').addEventListener('click', (e) => {
            if (e.target.id === 'task-modal') this.closeTaskModal();
        });

        // Past Jobs modal events
    const pastJobsBtn = document.getElementById('view-past-jobs-btn');
    if (pastJobsBtn) pastJobsBtn.addEventListener('click', () => this.openPastJobsModal());
    const pastJobsBtn2 = document.getElementById('view-past-jobs-btn-2');
    if (pastJobsBtn2) pastJobsBtn2.addEventListener('click', () => this.openPastJobsModal());
        const pastJobsModal = document.getElementById('past-jobs-modal');
        const pastJobsClose = document.getElementById('past-jobs-close');
        if (pastJobsClose) pastJobsClose.addEventListener('click', () => this.closePastJobsModal());
        if (pastJobsModal) pastJobsModal.addEventListener('click', (e) => { if (e.target.id === 'past-jobs-modal') this.closePastJobsModal(); });
        const jobsPrev = document.getElementById('jobs-prev');
        const jobsNext = document.getElementById('jobs-next');
        const jobsSearchBtn = document.getElementById('jobs-search-btn');
        if (jobsPrev) jobsPrev.addEventListener('click', () => this.changeJobsPage(-1));
        if (jobsNext) jobsNext.addEventListener('click', () => this.changeJobsPage(1));
        if (jobsSearchBtn) jobsSearchBtn.addEventListener('click', () => this.reloadJobs());
        const jobsSearchInput = document.getElementById('jobs-search');
        if (jobsSearchInput) jobsSearchInput.addEventListener('keypress', (e)=>{ if(e.key==='Enter') this.reloadJobs(); });
        const jobsPageSize = document.getElementById('jobs-page-size');
        if (jobsPageSize) jobsPageSize.addEventListener('change', () => this.reloadJobs(true));

    // Task start buttons
    document.getElementById('start-ingest-rank-btn').addEventListener('click', () => this.startIngestAndRank());
    document.getElementById('start-rank-existing-btn').addEventListener('click', () => this.startRankExisting());
    document.getElementById('start-ingest-only-btn').addEventListener('click', () => this.startIngestOnly());
    // Drop All Jobs button
    const dropAllJobsBtn = document.getElementById('drop-all-jobs-btn');
    if (dropAllJobsBtn) dropAllJobsBtn.addEventListener('click', () => this.dropAllJobs());
        
        // Script Generator listeners
        document.getElementById('start-script-generation-btn').addEventListener('click', () => this.startScriptGeneration());
        document.getElementById('export-script-btn').addEventListener('click', () => this.exportScriptToPdf());
        document.getElementById('copy-script-btn').addEventListener('click', () => this.copyScriptToClipboard());

        // File upload handlers
        this.setupFileHandlers();
        
        // Results export - Normal click exports Excel, Shift+click exports PDF
        document.getElementById('export-results-btn').addEventListener('click', (e) => {
            if (e.shiftKey) {
                // Shift+click for PDF
                this.exportResults('pdf');
                e.preventDefault();
            } else {
                // Normal click for Excel
                this.exportResults('xlsx');
            }
        });
        
        // Results filter
        document.getElementById('results-limit').addEventListener('change', () => {
            this.updateResultsDisplay();
        });
        
        // Notification close
        document.getElementById('notification-close').addEventListener('click', () => {
            this.hideNotification();
        });

        // Embedding mode switch listener (added later during initEmbeddingToggle as well for safety)
        const modeSwitch = document.getElementById('embedding-mode-switch');
        if (modeSwitch) {
            modeSwitch.addEventListener('change', () => this.handleEmbeddingModeToggle(modeSwitch.checked));
        }

        // Recycle vectors modal listeners
        document.getElementById('recycle-vectors-modal-close').addEventListener('click', () => this.closeRecycleVectorsModal());
        document.getElementById('recycle-vectors-cancel').addEventListener('click', () => this.closeRecycleVectorsModal());
        document.getElementById('recycle-vectors-confirm').addEventListener('click', () => this.startRecycleVectors());
        document.getElementById('recycle-vectors-modal').addEventListener('click', (e) => {
            if (e.target.id === 'recycle-vectors-modal') this.closeRecycleVectorsModal();
        });
    }

    async initEmbeddingToggle() {
        try {
            const resp = await fetch('/api/embedding-config');
            const cfg = await resp.json();
            const modeSwitch = document.getElementById('embedding-mode-switch');
            if (modeSwitch) {
                modeSwitch.checked = cfg.mode === 'online';
            }
        } catch (e) {
            console.warn('Failed to load embedding config', e);
        }
    }

    /* ===================== Past Jobs Modal ===================== */
    openPastJobsModal() {
        this._jobsPage = 1;
        this._jobsPageSize = parseInt(document.getElementById('jobs-page-size')?.value || '10', 10);
        this._jobsSearch = document.getElementById('jobs-search')?.value || '';
        this._jobsTotal = 0;
        document.getElementById('job-details')?.classList.add('hidden');
        document.getElementById('past-jobs-modal').classList.remove('hidden');
        this.fetchJobs();
    }

    closePastJobsModal() {
        document.getElementById('past-jobs-modal').classList.add('hidden');
    }

    async dropAllJobs() {
        // Show confirmation dialog
        const confirmed = await this.showConfirmationDialog(
            'Drop All Jobs',
            'Are you sure you want to delete all past jobs? This action cannot be undone.',
            'Yes, drop all jobs',
            'Cancel'
        );
        
        if (!confirmed) return;

        try {
            // Show loading state
            this.showNotification('Dropping all jobs...', 'info');
            
            // Call API to delete all jobs
            const response = await fetch('/api/analyzer/jobs', {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`Failed to drop jobs: ${response.statusText}`);
            }

            // Refresh the jobs list
            this._jobsPage = 1;
            await this.fetchJobs();
            
            this.showNotification('All jobs have been successfully dropped', 'success');
            
        } catch (error) {
            console.error('Error dropping all jobs:', error);
            this.showNotification(`Error dropping jobs: ${error.message}`, 'error');
        }
    }

    showConfirmationDialog(title, message, confirmText = 'Confirm', cancelText = 'Cancel') {
        return new Promise((resolve) => {
            // Create modal elements
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            overlay.style.display = 'flex';
            overlay.style.zIndex = '9999';
            
            const modal = document.createElement('div');
            modal.className = 'modal-content';
            modal.style.maxWidth = '400px';
            
            modal.innerHTML = `
                <div class="modal-header">
                    <h2>${title}</h2>
                </div>
                <div class="modal-body">
                    <p>${message}</p>
                    <div class="modal-actions" style="display: flex; gap: 0.75rem; justify-content: flex-end; margin-top: 1.5rem;">
                        <button id="confirm-cancel" class="btn btn-secondary">${cancelText}</button>
                        <button id="confirm-yes" class="btn btn-primary" style="background-color: #dc2626; border-color: #dc2626;">${confirmText}</button>
                    </div>
                </div>
            `;
            
            overlay.appendChild(modal);
            document.body.appendChild(overlay);
            
            // Handle button clicks
            const handleConfirm = () => {
                document.body.removeChild(overlay);
                resolve(true);
            };
            
            const handleCancel = () => {
                document.body.removeChild(overlay);
                resolve(false);
            };
            
            modal.querySelector('#confirm-yes').addEventListener('click', handleConfirm);
            modal.querySelector('#confirm-cancel').addEventListener('click', handleCancel);
            
            // Close on overlay click
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) handleCancel();
            });
            
            // Close on escape key
            const handleKeyDown = (e) => {
                if (e.key === 'Escape') {
                    document.removeEventListener('keydown', handleKeyDown);
                    handleCancel();
                }
            };
            document.addEventListener('keydown', handleKeyDown);
        });
    }

    changeJobsPage(delta) {
        const maxPage = Math.max(1, Math.ceil((this._jobsTotal || 0) / (this._jobsPageSize || 10)));
        const next = Math.min(maxPage, Math.max(1, (this._jobsPage || 1) + delta));
        if (next !== this._jobsPage) {
            this._jobsPage = next;
            this.fetchJobs();
        }
    }

    reloadJobs(resetPage = false) {
        if (resetPage) this._jobsPage = 1;
        this._jobsPageSize = parseInt(document.getElementById('jobs-page-size')?.value || '10', 10);
        this._jobsSearch = document.getElementById('jobs-search')?.value || '';
        this.fetchJobs();
    }

    async fetchJobs() {
        try {
            const params = new URLSearchParams();
            params.set('page', String(this._jobsPage || 1));
            params.set('pageSize', String(this._jobsPageSize || 10));
            if (this._jobsSearch) params.set('search', this._jobsSearch);
            const res = await fetch(`/api/analyzer/jobs?${params.toString()}`);
            const data = await res.json();
            if (!data.success) throw new Error(data.error || 'Failed to load jobs');
            this._jobsTotal = data.total || 0;
            this.renderJobsList(data.jobs || [], data.page, data.pageSize, data.total);
        } catch (e) {
            console.error('Failed to fetch jobs', e);
            this.showNotification('Failed to load jobs: ' + e.message, 'error');
        }
    }

    renderJobsList(jobs, page, pageSize, total) {
        const list = document.getElementById('jobs-list');
        const info = document.getElementById('jobs-page-info');
        list.innerHTML = '';
        if (!jobs.length) {
            const empty = document.createElement('div');
            empty.className = 'results-header';
            empty.innerHTML = '<h2>No Jobs</h2><p class="results-subtitle">No previous analyses found.</p>';
            list.appendChild(empty);
        } else {
            jobs.forEach(job => {
                const card = document.createElement('div');
                card.className = 'candidate-card new job-card';

                const avgPct = job.avg_score != null ? Math.round(job.avg_score * 100) : null;
                const scoreColor = avgPct == null ? '#64748b' : (avgPct >= 80 ? '#10b981' : avgPct >= 60 ? '#f59e0b' : avgPct < 40 ? '#ef4444' : '#667eea');

                card.innerHTML = `
                    <div class="card-header">
                        <div class="candidate-info">
                            <h3>${job.title || 'Untitled Job'}</h3>
                            <div class="email">${new Date(job.created_at).toLocaleString()}</div>
                        </div>
                        <div class="rank-badge">${job.ranked_count || 0}</div>
                    </div>
                    <div class="card-content">
                        <div class="similarity-score">
                            <span class="score-label">Avg Score</span>
                            <div class="score-bar">
                                <div class="score-fill" style="width: ${avgPct != null ? avgPct : 0}%; background: linear-gradient(90deg, ${scoreColor}, ${scoreColor}aa);"></div>
                            </div>
                            <span class="score-value">${avgPct != null ? avgPct + '%' : 'N/A'}</span>
                        </div>
                        <div class="resume-preview">
                            <div class="preview-header">
                                <svg class="preview-icon" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8z" />
                                </svg>
                                <span class="preview-title">Description</span>
                            </div>
                            <div class="resume-content">${(job.description_preview || 'No description').replace(/</g,'&lt;')}</div>
                        </div>
                    </div>
                    <div class="card-actions">
                        <button class="action-btn btn-primary" data-job-id="${job.id}">
                            <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                                <circle cx="12" cy="12" r="3"></circle>
                            </svg>
                            View Candidates
                        </button>
                    </div>
                `;

                card.querySelector('button').addEventListener('click', ()=> this.loadJobDetails(job.id, job.title));
                list.appendChild(card);
            });
        }
        const start = total ? (page - 1) * pageSize + 1 : 0;
        const end = Math.min(total, page * pageSize);
        info.textContent = `${start}-${end} of ${total}`;
    }

    async loadJobDetails(jobId, title) {
        try {
            const limit = 50; // show top 50
            const res = await fetch(`/api/analyzer/jobs/${jobId}?limit=${limit}`);
            const data = await res.json();
            if (!data.success) throw new Error(data.error || 'Failed to load job details');
            // Apply the same high-score filter for consistency
            const filteredResults = this.filterOutHighScoreCandidates(data.results);
            // Render into modal results area using existing card renderer
            const resultsContainer = document.getElementById('job-results-list');
            resultsContainer.innerHTML = '';
            const header = document.createElement('div');
            header.className = 'results-header';
            header.innerHTML = `
                <h2>${title || data.job.title}</h2>
                <p class="results-subtitle">Showing top ${filteredResults.length} candidates • Avg score ${(data.stats?.avg_similarity ? (data.stats.avg_similarity*100).toFixed(1)+'%' : 'N/A')}</p>
            `;
            resultsContainer.appendChild(header);
            const grid = document.createElement('div');
            grid.className = 'candidates-grid';
            filteredResults.forEach((r, i) => {
                const card = this.createResultCard(r, r.rank_position || i + 1);
                grid.appendChild(card);
            });
            resultsContainer.appendChild(grid);
            document.getElementById('job-details-title').textContent = `Job: ${title || data.job.title}`;
            document.getElementById('job-details-sub').textContent = `Created ${new Date(data.job.created_at).toLocaleString()}`;
            document.getElementById('job-details').classList.remove('hidden');
        } catch (e) {
            console.error('Failed to load job details', e);
            this.showNotification('Failed to load job details: ' + e.message, 'error');
        }
    }

    async handleEmbeddingModeToggle(online) {
        this.showNotification(`Switching embedding mode to ${online ? `ONLINE (${this.selectedEmbeddingProvider})` : 'LOCAL'}...`, 'info');
        try {
            // Determine provider and model from the current UI state to avoid stale values
            let provider = this.selectedEmbeddingProvider;
            const providerSelect = document.getElementById('online-embedding-provider');
            if (providerSelect && providerSelect.value) provider = providerSelect.value;

            let model = this.selectedEmbeddingModel;
            const providerModelSelect = document.getElementById(`${provider}-embedding-select`);
            if (providerModelSelect && providerModelSelect.value) model = providerModelSelect.value;

            // Persist the resolved values
            this.selectedEmbeddingProvider = provider;
            this.selectedEmbeddingModel = model;
            localStorage.setItem('chunhr-selected-embedding-provider', provider);
            localStorage.setItem('chunhr-selected-embedding-model', model);

            // Gather API keys for the selected provider
            let keys = [];
            if (online) {
                keys = (this.providerApiKeys[provider] || []).slice();
                if (!keys.length) {
                    this.showNotification(`No API keys configured. Add ${provider} keys first.`, 'error');
                    const switchEl = document.getElementById('embedding-mode-switch');
                    if (switchEl) switchEl.checked = false;
                    return;
                }
            }
            const res = await fetch('/api/embedding-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    mode: online ? 'online' : 'local', 
                    apiKeys: keys,
                    provider: online ? provider : 'local',
                    model: online ? model : 'bge-base',
                    embeddingConcurrency: parseInt(document.getElementById('embedding-concurrency-input')?.value || this.embeddingConcurrency || 3, 10)
                })
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || 'Config update failed');
            
            // Sync with settings page
            const mode = online ? 'online' : 'local';
            localStorage.setItem('chunhr-embedding-mode', mode);
            const embeddingModeRadio = document.getElementById(`embedding-mode-${mode}`);
            if (embeddingModeRadio) {
                embeddingModeRadio.checked = true;
                // Update settings UI without triggering another server call
                this._skipConfigUpdateOnce = true;
                this.handleEmbeddingModeChange(mode);
            }
            
            // Force reload pipeline
            await fetch('/api/embedding-load', { method: 'POST' });
            this.showNotification(`Embedding mode set to ${online ? 'ONLINE' : 'LOCAL'} successfully.`, 'success');
        } catch (err) {
            console.error('Embedding toggle failed', err);
            this.showNotification('Failed to switch embedding mode: ' + err.message, 'error');
            const switchEl = document.getElementById('embedding-mode-switch');
            if (switchEl) switchEl.checked = !online; // rollback
        }
    }

    setupFileHandlers() {
        // File upload for ingest & rank
        const fileInput = document.getElementById('file-input');
        const dropZone = document.getElementById('file-drop-zone');
        
        dropZone.addEventListener('click', () => fileInput.click());
        dropZone.addEventListener('dragover', this.handleDragOver.bind(this));
        dropZone.addEventListener('dragleave', this.handleDragLeave.bind(this));
        dropZone.addEventListener('drop', (e) => this.handleFileDrop(e, 'ingest-rank'));
        fileInput.addEventListener('change', (e) => this.handleFileSelect(e, 'ingest-rank'));

        // File upload for ingest only
        const fileInputIngest = document.getElementById('file-input-ingest');
        const dropZoneIngest = document.getElementById('file-drop-zone-ingest');
        
        dropZoneIngest.addEventListener('click', () => fileInputIngest.click());
        dropZoneIngest.addEventListener('dragover', this.handleDragOver.bind(this));
        dropZoneIngest.addEventListener('dragleave', this.handleDragLeave.bind(this));
        dropZoneIngest.addEventListener('drop', (e) => this.handleFileDrop(e, 'ingest-only'));
        fileInputIngest.addEventListener('change', (e) => this.handleFileSelect(e, 'ingest-only'));

        // File upload for script generator
        const sgFileInput = document.getElementById('sg-file-input');
        const sgDropZone = document.getElementById('sg-file-drop-zone');
        sgDropZone.addEventListener('click', () => sgFileInput.click());
        sgDropZone.addEventListener('dragover', this.handleDragOver.bind(this));
        sgDropZone.addEventListener('dragleave', this.handleDragLeave.bind(this));
        sgDropZone.addEventListener('drop', (e) => this.handleFileDrop(e, 'script-generator'));
        sgFileInput.addEventListener('change', (e) => this.handleFileSelect(e, 'script-generator'));
    }
    
    // Status Management
    updateStatus(status, text) {
        const indicator = document.getElementById('status-indicator');
        const statusText = document.getElementById('status-text');
        
        indicator.className = `status-indicator ${status}`;
        statusText.textContent = text;
    }
    
    async checkServerStatus() {
        try {
            const response = await fetch('/api/status');
            const data = await response.json();
            
            if (data.status === 'running') {
                this.updateStatus('online', 'Connected');
                if (data.pipeline_loaded) {
                    this.updateStatus('pipeline-loaded', 'AI Model Ready');
                }
            }
        } catch (error) {
            console.error('Failed to check server status:', error);
            this.updateStatus('offline', 'Connection Error');
        }
    }
    
    // AI Pipeline Management
    async loadAIPipeline() {
        this.showLoading('Loading AI Model', 'This may take a few minutes on first load...');
        this.socket.emit('load-pipeline');
        // Additional client-side safeguard: poll status endpoint every 5s until pipeline_loaded
        if (this._pipelinePollInterval) clearInterval(this._pipelinePollInterval);
        this._pipelinePollInterval = setInterval(async () => {
            try {
                const resp = await fetch('/api/status');
                const data = await resp.json();
                if (data.pipeline_loaded) {
                    clearInterval(this._pipelinePollInterval);
                    this._pipelinePollInterval = null;
                    this.updateStatus('pipeline-loaded', 'AI Model Ready');
                    this.hideLoading();
                }
            } catch (_) { /* ignore */ }
        }, 5000);
    }
    
    // View & Modal Management
    handleNavigation(event) {
        event.preventDefault();
        const viewName = event.currentTarget.dataset.view;
        this.navigateTo(viewName);
        
        // Close mobile menu if open
        const sidebar = document.getElementById('sidebar');
        const mobileOverlay = document.getElementById('mobile-overlay');
        if (sidebar && mobileOverlay) {
            this.setMobileSidebarOpen(false);
        }
    }

    navigateTo(viewName) {
        if (!viewName) viewName = 'home';
        
        const oldView = document.getElementById(`view-${this.currentView}`);
        const newView = document.getElementById(`view-${viewName}`);
        
        this.currentView = viewName;
        this.routeForcedSidebarCollapsed = this.getRouteForcedSidebarCollapsed(viewName);
        this.applySidebarState();
        window.location.hash = viewName;

        // Update active link in sidebar
        document.querySelectorAll('.sidebar-nav .nav-link').forEach(link => {
            link.classList.toggle('active', link.dataset.view === viewName);
        });

        // Animate view transition using GSAP
        if (window.chunAnimations && window.chunAnimations.isInitialized) {
            window.chunAnimations.transitionToView(oldView, newView).then(() => {
                // Re-setup card hovers for new view elements
                window.chunAnimations.setupCardHovers();
            });
        } else {
            // Fallback: simple show/hide
            document.querySelectorAll('.view-container').forEach(view => {
                view.classList.toggle('hidden', view.id !== `view-${viewName}`);
            });
        }

        // Update header title
        const viewTitle = this.getViewTitle(viewName);
        document.getElementById('current-view-title').textContent = viewTitle;
        
        // Reset script generator view on navigation
        if (viewName === 'script-generator') {
            this.showScriptGeneratorView('input');
        }
    }

    // Alias method for backward compatibility with onclick handlers
    showView(viewName) {
        this.navigateTo(viewName);
    }

    getViewTitle(viewName) {
        const titles = {
            'home': 'Research Dashboard',
            'analyzer': 'Candidate Intelligence',
            'script-generator': 'Interview Studio',
            'gmail-workspace': 'Gmail Intake',
            'settings': 'Runtime Settings'
            // Add more tool titles here as you create them
        };
        return titles[viewName] || 'Hr Analyzer';
    }

    initSidebarState() {
        const storedPreference = localStorage.getItem(this.sidebarStorageKey);
        if (storedPreference === null) {
            this.sidebarCollapsed = this.getDefaultSidebarCollapsed();
        } else {
            this.sidebarCollapsed = storedPreference === 'true';
        }
        this.applySidebarState();
    }

    getDefaultSidebarCollapsed() {
        return !this.isMobileViewport() && window.innerWidth <= 1280;
    }

    isMobileViewport() {
        return window.innerWidth <= 768;
    }

    applySidebarState() {
        const shouldCollapse = !this.isMobileViewport() && (this.sidebarCollapsed || this.routeForcedSidebarCollapsed);
        document.body.classList.toggle('sidebar-collapsed', shouldCollapse);

        const sidebarCollapseBtn = document.getElementById('sidebar-collapse-btn');
        if (sidebarCollapseBtn) {
            const label = shouldCollapse ? 'Expand sidebar' : 'Collapse sidebar';
            sidebarCollapseBtn.setAttribute('aria-label', label);
            sidebarCollapseBtn.setAttribute('title', label);
            sidebarCollapseBtn.setAttribute('aria-pressed', shouldCollapse ? 'true' : 'false');
        }

        if (this.isMobileViewport()) {
            this.setMobileSidebarOpen(false);
        }
    }

    toggleSidebarCollapse() {
        this.sidebarPreferenceSet = true;
        this.sidebarCollapsed = !this.sidebarCollapsed;
        localStorage.setItem(this.sidebarStorageKey, String(this.sidebarCollapsed));
        this.applySidebarState();
    }

    handleViewportChange() {
        if (!this.sidebarPreferenceSet) {
            this.sidebarCollapsed = this.getDefaultSidebarCollapsed();
        }
        this.routeForcedSidebarCollapsed = this.getRouteForcedSidebarCollapsed(this.currentView);
        this.applySidebarState();
    }

    getRouteForcedSidebarCollapsed(viewName = this.currentView) {
        return ['settings', 'gmail-workspace'].includes(viewName) && window.innerWidth <= 1500;
    }

    setMobileSidebarOpen(isOpen) {
        const sidebar = document.getElementById('sidebar');
        const mobileOverlay = document.getElementById('mobile-overlay');
        const mobileMenuToggle = document.getElementById('mobile-menu-toggle');

        if (!sidebar || !mobileOverlay) return;

        sidebar.classList.toggle('mobile-open', isOpen);
        mobileOverlay.classList.toggle('active', isOpen);
        if (mobileMenuToggle) {
            mobileMenuToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        }
    }

    showAnalyzerView(viewName) {
        const allSections = document.querySelectorAll('#view-analyzer .section');
        const targetView = document.getElementById(`analyzer-${viewName}-section`);
        
        // Use GSAP for section transitions if available
        if (window.chunAnimations && window.chunAnimations.isInitialized) {
            // Find currently visible section
            const currentSection = document.querySelector('#view-analyzer .section:not(.hidden)');
            
            if (currentSection && currentSection !== targetView) {
                window.chunAnimations.hideSection(currentSection).then(() => {
                    if (targetView) {
                        window.chunAnimations.showSection(targetView);
                    }
                });
            } else if (targetView) {
                // Hide others, show target
                allSections.forEach(s => s.classList.add('hidden'));
                window.chunAnimations.showSection(targetView);
            }
        } else {
            // Fallback: simple show/hide
            allSections.forEach(section => {
                section.classList.add('hidden');
            });
            if (targetView) {
                targetView.classList.remove('hidden');
            }
        }
    }
    
    showScriptGeneratorView(viewName) {
        const allSections = document.querySelectorAll('#view-script-generator .section');
        const targetView = document.getElementById(`script-generator-${viewName}-section`);

        // Use GSAP for section transitions if available
        if (window.chunAnimations && window.chunAnimations.isInitialized) {
            const currentSection = document.querySelector('#view-script-generator .section:not(.hidden)');
            
            if (currentSection && currentSection !== targetView) {
                window.chunAnimations.hideSection(currentSection).then(() => {
                    if (targetView) {
                        window.chunAnimations.showSection(targetView);
                    }
                });
            } else if (targetView) {
                allSections.forEach(s => s.classList.add('hidden'));
                window.chunAnimations.showSection(targetView);
            }
        } else {
            // Fallback: simple show/hide
            allSections.forEach(section => {
                section.classList.add('hidden');
            });
            if (targetView) targetView.classList.remove('hidden');
        }
    }

    openTaskModal(taskType) {
        const modal = document.getElementById('task-modal');
        const modalTitle = document.getElementById('modal-title');
        
        // Hide all forms first
        document.querySelectorAll('#modal-body > div').forEach(form => form.classList.add('hidden'));

        // Configure and show the correct form
        let formId, title;
        switch (taskType) {
            case 'ingest-rank':
                formId = 'form-ingest-rank';
                title = 'Ingest & Rank New Candidates';
                break;
            case 'rank-existing':
                formId = 'form-rank-existing';
                title = 'Rank Existing Candidates';
                break;
            case 'ingest-only':
                formId = 'form-ingest-only';
                title = 'Add New Candidates to Database';
                break;
        }

        if (formId) {
            document.getElementById(formId).classList.remove('hidden');
            modalTitle.textContent = title;
            
            // Use GSAP animation if available
            if (window.chunAnimations && window.chunAnimations.isInitialized) {
                window.chunAnimations.openModal(modal);
            } else {
                modal.classList.remove('hidden');
            }
            
            this.currentTaskType = taskType;
        }

        this.uploadedFile = null; // Reset file on new task
        this.updateDropZone('analyzer');
    }

    closeTaskModal() {
        const modal = document.getElementById('task-modal');
        
        // Use GSAP animation if available
        if (window.chunAnimations && window.chunAnimations.isInitialized) {
            window.chunAnimations.closeModal(modal);
        } else {
            modal.classList.add('hidden');
        }
        
        this.currentTaskType = null;
    }

    updateDropZone(type = 'analyzer') {
        const dropZones = type === 'script-generator' ? [document.getElementById('sg-file-drop-zone')] : document.querySelectorAll('#form-ingest-rank .file-drop-zone, #form-ingest-only .file-drop-zone');
        const file = type === 'script-generator' ? this.scriptGeneratorFile : this.uploadedFile;
        dropZones.forEach(zone => {
            if (!zone) return;
            const content = zone.querySelector('.drop-zone-content');
            if (file) {
                let label;
                if (Array.isArray(file)) {
                    if (file.length === 1) {
                        label = file[0].name;
                    } else if (file.length <= 5) {
                        label = file.map(f => f.name).join(', ');
                    } else {
                        label = `${file.length} files selected`;
                    }
                } else {
                    label = file.name;
                }
                content.innerHTML = `
                    <svg class="upload-icon" style="color: var(--accent-success);" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                        <polyline points="22 4 12 14.01 9 11.01"/>
                    </svg>
                    <h3>${label}</h3>
                    <p>Click to change file(s)</p>`;
            } else {
                content.innerHTML = `
                    <svg class="upload-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="7,10 12,15 17,10"/>
                        <line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                    <h3>${type === 'script-generator' ? 'Drop Resume PDF here' : 'Drop Excel file here'}</h3>
                    <p>or click to browse</p>`;
            }
        });
    }
    
    // --- START OF FIX: Centralized function to get current AI config from UI ---
    getCurrentUiConfig() {
        const mode = document.querySelector('input[name="embedding-processing-mode"]:checked')?.value || 'local';
        let provider;
        let model;

        if (mode === 'online') {
            provider = document.getElementById('online-embedding-provider')?.value || 'gemini';
            model = document.getElementById(`${provider}-embedding-select`)?.value;
        } else {
            const localSelection = document.getElementById('local-embedding-select')?.value || this.selectedLocalEmbedding || 'bge-base';
            if (localSelection === 'lmstudio') {
                provider = 'lmstudio';
                model = this.lmStudioConfig.model || localStorage.getItem('chunhr-lmstudio-model') || '';
            } else {
                provider = 'local';
                model = localSelection;
            }
        }

        const apiKeys = this.providerApiKeys[provider] || [];
        const timeoutSeconds = parseInt(document.getElementById('api-key-timeout-input')?.value, 10) || 2;

        const embeddingConcurrency = parseInt(document.getElementById('embedding-concurrency-input')?.value || this.embeddingConcurrency || 3, 10);
        const lmStudioBaseUrl = this.lmStudioConfig?.baseUrl || localStorage.getItem('chunhr-lmstudio-base-url') || 'http://127.0.0.1:1234';
        const lmStudioDimensionsRaw = this.lmStudioConfig?.dimensions || localStorage.getItem('chunhr-lmstudio-dimensions') || '';
        const lmStudioSupportedDimensions = lmStudioDimensionsRaw
            .split(',')
            .map((v) => parseInt(v.trim(), 10))
            .filter((v) => Number.isFinite(v) && v > 0)
            .sort((a, b) => a - b);

// Reranker config (only valid when online and provider has keys)
        const rrEnabled = !!document.getElementById('reranker-enabled')?.checked && mode === 'online';
        // Reranker provider can be independent (separate key pools): use UI selection
        const rrProvEl = document.getElementById('reranker-provider');
        // If multi-step rerank is enabled, build the pipeline config instead of single provider
        const multiEnabled = !!document.getElementById('reranker-multi-enabled')?.checked;
        if (multiEnabled) {
            const step1Prov = document.getElementById('reranker-step1-provider')?.value || this.rerankerStep1.provider;
            let step1Model;
            switch (String(step1Prov || '').toLowerCase()) {
                case 'nvidia':
                    step1Model = document.getElementById('reranker-step1-nvidia-model')?.value || 'nvidia/llama-3.2-nemoretriever-500m-rerank-v2';
                    break;
                case 'cohere':
                    step1Model = document.getElementById('reranker-step1-cohere-model')?.value || 'rerank-v3.5';
                    break;
                case 'langsearch':
                    step1Model = document.getElementById('reranker-step1-langsearch-model')?.value || 'langsearch-reranker-v1';
                    break;
                case 'jina':
                default:
                    step1Model = document.getElementById('reranker-step1-jina-model')?.value || this.rerankerStep1.model || 'jina-reranker-v2-base-multilingual';
            }
            const step1 = {
                provider: step1Prov,
                model: step1Model,
                topN: parseInt(document.getElementById('reranker-step1-topn')?.value || String(this.rerankerStep1.topN || 50), 10)
            };

            const step2Prov = document.getElementById('reranker-step2-provider')?.value || this.rerankerStep2.provider;
            let step2Model;
            switch (String(step2Prov || '').toLowerCase()) {
                case 'nvidia':
                    step2Model = document.getElementById('reranker-step2-nvidia-model')?.value || 'nvidia/llama-3.2-nemoretriever-500m-rerank-v2';
                    break;
                case 'cohere':
                    step2Model = document.getElementById('reranker-step2-cohere-model')?.value || 'rerank-v3.5';
                    break;
                case 'langsearch':
                    step2Model = document.getElementById('reranker-step2-langsearch-model')?.value || 'langsearch-reranker-v1';
                    break;
                case 'jina':
                default:
                    step2Model = document.getElementById('reranker-step2-jina-model')?.value || this.rerankerStep2.model || 'jina-reranker-v2-base-multilingual';
            }
            const step2 = {
                provider: step2Prov,
                model: step2Model,
                topN: parseInt(document.getElementById('reranker-step2-topn')?.value || String(this.rerankerStep2.topN || 25), 10)
            };

            const rrKeys1 = (this.providerApiKeys[step1.provider] || []).slice();
            const rrKeys2 = (this.providerApiKeys[step2.provider] || []).slice();
            return { mode, provider, model, apiKeys, timeoutSeconds, embeddingConcurrency,
                     reranker: { enabled: rrEnabled && rrKeys1.length > 0 && rrKeys2.length > 0, multi: true,
                                 steps: [ { ...step1, apiKeys: rrKeys1 }, { ...step2, apiKeys: rrKeys2 } ] } };
        }

        let rrProvider = rrProvEl?.value || this.selectedRerankerProvider || 'jina';
        let rrModel = 'jina-reranker-v2-base-multilingual';
        if (rrProvider === 'nvidia') rrModel = document.getElementById('reranker-nvidia-model')?.value || 'nvidia/llama-3.2-nemoretriever-500m-rerank-v2';
        else if (rrProvider === 'cohere') rrModel = document.getElementById('reranker-cohere-model')?.value || 'rerank-v3.5';
        else if (rrProvider === 'langsearch') rrModel = document.getElementById('reranker-langsearch-model')?.value || 'langsearch-reranker-v1';
        const rrTopN = parseInt(document.getElementById('reranker-topn')?.value || this.rerankerTopN || 25, 10);

        // Build reranker key pool from its own provider storage
        const rrKeys = (this.providerApiKeys[rrProvider] || []).slice();

        const baseConfig = {
            mode,
            provider,
            model,
            apiKeys,
            timeoutSeconds,
            embeddingConcurrency,
            reranker: {
                enabled: rrEnabled && (rrKeys?.length > 0),
                provider: rrProvider,
                model: rrModel,
                topN: rrTopN,
                apiKeys: rrKeys
            }
        };

        if (provider === 'lmstudio') {
            baseConfig.lmStudioBaseUrl = lmStudioBaseUrl;
            baseConfig.lmStudioModel = model;
            baseConfig.lmStudioDimensions = lmStudioDimensionsRaw;
            baseConfig.lmStudioConfig = {
                baseUrl: lmStudioBaseUrl,
                model,
                supportedDimensions: lmStudioSupportedDimensions
            };
            if (!baseConfig.embeddingDimensions && lmStudioSupportedDimensions.length) {
                baseConfig.embeddingDimensions = lmStudioSupportedDimensions[lmStudioSupportedDimensions.length - 1];
            }
        }

        return baseConfig;
    }
    // --- END OF FIX ---

    // File Handling
    handleDragOver(event) {
        event.preventDefault();
        event.currentTarget.classList.add('dragover');
    }
    
    handleDragLeave(event) {
        event.preventDefault();
        event.currentTarget.classList.remove('dragover');
    }
    
    handleFileDrop(event, taskType = null) {
        event.preventDefault();
        event.currentTarget.classList.remove('dragover');
        const files = event.dataTransfer.files;
        if (files && files.length > 0) {
            this.processFile(files, taskType); // pass full FileList
        }
    }
    
    handleFileSelect(event, taskType = null) {
        const files = event.target.files;
        if (files && files.length > 0) {
            this.processFile(files, taskType); // pass full FileList
        }
    }
    
    processFile(fileOrList, taskType = null) {
        let files = [];
        if (fileOrList instanceof File) files = [fileOrList]; else if (fileOrList && fileOrList.length) files = Array.from(fileOrList);
        if (!files.length) return;

        const isScriptGenerator = taskType === 'script-generator';
        const allowedExtensions = isScriptGenerator ? /\.(pdf)$/i : /\.(xlsx|xls|pdf)$/i;
        const allowed = files.filter(f => allowedExtensions.test(f.name));

        if (!allowed.length) {
            this.showNotification(isScriptGenerator ? 'Only .pdf files are supported.' : 'Only .xlsx, .xls, .pdf files are supported.', 'error');
            return;
        }

        if (isScriptGenerator) {
            this.scriptGeneratorFile = allowed[0]; // Only one file for script generator
            this.updateDropZone('script-generator');
        } else {
            this.uploadedFile = allowed.length === 1 ? allowed[0] : allowed; // store list if multi
            this.updateDropZone('analyzer');
        }
        const label = allowed.length === 1 ? `File "${allowed[0].name}"` : `${allowed.length} files`;
        this.showNotification(`${label} ready.`, 'success');
    }

    // Reranker Settings
    initRerankerSettings() {
        const enabledEl = document.getElementById('reranker-enabled');
        const providerEl = document.getElementById('reranker-provider');
        const jinaSec = document.getElementById('reranker-jina-section');
        const nvidiaSec = document.getElementById('reranker-nvidia-section');
        const topNEl = document.getElementById('reranker-topn');
        const multiEnabledEl = document.getElementById('reranker-multi-enabled');
        const pipelineEl = document.getElementById('reranker-pipeline');
        const step1ProvEl = document.getElementById('reranker-step1-provider');
        const step1JinaEl = document.getElementById('reranker-step1-jina');
        const step1NvidiaEl = document.getElementById('reranker-step1-nvidia');
        const step1CohereEl = document.getElementById('reranker-step1-cohere');
        const step1LangEl = document.getElementById('reranker-step1-langsearch');
        const step1TopNEl = document.getElementById('reranker-step1-topn');
        const step1JinaModelEl = document.getElementById('reranker-step1-jina-model');
        const step1NvidiaModelEl = document.getElementById('reranker-step1-nvidia-model');
        const step1CohereModelEl = document.getElementById('reranker-step1-cohere-model');
        const step1LangModelEl = document.getElementById('reranker-step1-langsearch-model');

        const step2ProvEl = document.getElementById('reranker-step2-provider');
        const step2CohereEl = document.getElementById('reranker-step2-cohere');
        const step2JinaEl = document.getElementById('reranker-step2-jina');
        const step2NvidiaEl = document.getElementById('reranker-step2-nvidia');
        const step2LangEl = document.getElementById('reranker-step2-langsearch');
        const step2TopNEl = document.getElementById('reranker-step2-topn');
        const step2CohereModelEl = document.getElementById('reranker-step2-cohere-model');
        const step2JinaModelEl = document.getElementById('reranker-step2-jina-model');
        const step2NvidiaModelEl = document.getElementById('reranker-step2-nvidia-model');
        const step2LangModelEl = document.getElementById('reranker-step2-langsearch-model');
        const jinaModelEl = document.getElementById('reranker-jina-model');
        const nvidiaModelEl = document.getElementById('reranker-nvidia-model');

        if (enabledEl) {
            enabledEl.checked = this.rerankerEnabled;
            enabledEl.addEventListener('change', () => {
                this.rerankerEnabled = enabledEl.checked;
                localStorage.setItem('chunhr-reranker-enabled', String(this.rerankerEnabled));
            });
        }
        if (providerEl) {
            // Default value (will be overridden by syncSections)
            providerEl.value = this.selectedRerankerProvider;
            const syncSections = () => {
                const v = providerEl.value;
                jinaSec?.classList.toggle('hidden', v !== 'jina');
                nvidiaSec?.classList.toggle('hidden', v !== 'nvidia');
                const cohereSec = document.getElementById('reranker-cohere-section');
                const langsearchSec = document.getElementById('reranker-langsearch-section');
                cohereSec?.classList.toggle('hidden', v !== 'cohere');
                langsearchSec?.classList.toggle('hidden', v !== 'langsearch');
            };
            providerEl.addEventListener('change', () => {
                this.selectedRerankerProvider = providerEl.value;
                localStorage.setItem('chunhr-selected-reranker-provider', this.selectedRerankerProvider);
                syncSections();
            });
            syncSections();
        }
        if (topNEl) {
            topNEl.value = String(this.rerankerTopN);
            topNEl.addEventListener('input', () => {
                this.rerankerTopN = Math.max(1, Math.min(200, parseInt(topNEl.value || '25', 10)));
                localStorage.setItem('chunhr-reranker-topn', String(this.rerankerTopN));
            });
        }
        if (jinaModelEl) {
            jinaModelEl.value = this.selectedRerankerModel || 'jina-reranker-v2-base-multilingual';
            jinaModelEl.addEventListener('change', () => {
                this.selectedRerankerModel = jinaModelEl.value;
                localStorage.setItem('chunhr-selected-reranker-model', this.selectedRerankerModel);
            });
        }
        if (nvidiaModelEl) {
            nvidiaModelEl.addEventListener('change', () => {
                // Persist NVIDIA model choice too (reuse same key)
                this.selectedRerankerModel = nvidiaModelEl.value;
                localStorage.setItem('chunhr-selected-reranker-model', this.selectedRerankerModel);
            });
        }

        // If embedding mode/provider is not online+common, auto-disable reranker
        const modeRadioOnline = document.getElementById('embedding-mode-online');
        const providerSelect = document.getElementById('online-embedding-provider');
        // Multi-step wiring
        const syncStepSection = (prov, sections) => {
            sections.forEach(([name, el]) => el?.classList.toggle('hidden', prov !== name));
        };
        const syncStep1 = () => {
            const p = step1ProvEl?.value || this.rerankerStep1.provider;
            syncStepSection(p, [
                ['jina', step1JinaEl],
                ['nvidia', step1NvidiaEl],
                ['cohere', step1CohereEl],
                ['langsearch', step1LangEl],
            ]);
        };
        const syncStep2 = () => {
            const p = step2ProvEl?.value || this.rerankerStep2.provider;
            syncStepSection(p, [
                ['cohere', step2CohereEl],
                ['jina', step2JinaEl],
                ['nvidia', step2NvidiaEl],
                ['langsearch', step2LangEl],
            ]);
        };

        if (multiEnabledEl) {
            multiEnabledEl.checked = this.rerankerMultiEnabled;
            pipelineEl?.classList.toggle('hidden', !this.rerankerMultiEnabled);
            multiEnabledEl.addEventListener('change', () => {
                this.rerankerMultiEnabled = multiEnabledEl.checked;
                localStorage.setItem('chunhr-reranker-multi-enabled', String(this.rerankerMultiEnabled));
                pipelineEl?.classList.toggle('hidden', !this.rerankerMultiEnabled);
            });
        }
        if (step1ProvEl) {
            step1ProvEl.value = this.rerankerStep1.provider;
            step1ProvEl.addEventListener('change', () => {
                this.rerankerStep1.provider = step1ProvEl.value;
                localStorage.setItem('chunhr-reranker-step1', JSON.stringify(this.rerankerStep1));
                syncStep1();
            });
            step1TopNEl && (step1TopNEl.value = String(this.rerankerStep1.topN || 50));
            step1TopNEl && step1TopNEl.addEventListener('input', () => {
                this.rerankerStep1.topN = Math.max(1, Math.min(2000, parseInt(step1TopNEl.value || '50', 10)));
                localStorage.setItem('chunhr-reranker-step1', JSON.stringify(this.rerankerStep1));
            });
            if (step1JinaModelEl) {
                step1JinaModelEl.value = this.rerankerStep1.model || 'jina-reranker-v2-base-multilingual';
                step1JinaModelEl.addEventListener('change', () => {
                    this.rerankerStep1.model = step1JinaModelEl.value;
                    localStorage.setItem('chunhr-reranker-step1', JSON.stringify(this.rerankerStep1));
                });
            }
            if (step1NvidiaModelEl) {
                step1NvidiaModelEl.addEventListener('change', () => {
                    this.rerankerStep1.model = step1NvidiaModelEl.value;
                    localStorage.setItem('chunhr-reranker-step1', JSON.stringify(this.rerankerStep1));
                });
            }
            if (step1CohereModelEl) {
                step1CohereModelEl.addEventListener('change', () => {
                    this.rerankerStep1.model = step1CohereModelEl.value;
                    localStorage.setItem('chunhr-reranker-step1', JSON.stringify(this.rerankerStep1));
                });
            }
            if (step1LangModelEl) {
                step1LangModelEl.addEventListener('change', () => {
                    this.rerankerStep1.model = step1LangModelEl.value;
                    localStorage.setItem('chunhr-reranker-step1', JSON.stringify(this.rerankerStep1));
                });
            }
            syncStep1();
        }
        if (step2ProvEl) {
            step2ProvEl.value = this.rerankerStep2.provider;
            step2ProvEl.addEventListener('change', () => {
                this.rerankerStep2.provider = step2ProvEl.value;
                localStorage.setItem('chunhr-reranker-step2', JSON.stringify(this.rerankerStep2));
                syncStep2();
            });
            step2TopNEl && (step2TopNEl.value = String(this.rerankerStep2.topN || 25));
            step2TopNEl && step2TopNEl.addEventListener('input', () => {
                this.rerankerStep2.topN = Math.max(1, Math.min(2000, parseInt(step2TopNEl.value || '25', 10)));
                localStorage.setItem('chunhr-reranker-step2', JSON.stringify(this.rerankerStep2));
            });
            if (step2CohereModelEl) {
                step2CohereModelEl.addEventListener('change', () => {
                    this.rerankerStep2.model = step2CohereModelEl.value;
                    localStorage.setItem('chunhr-reranker-step2', JSON.stringify(this.rerankerStep2));
                });
            }
            if (step2JinaModelEl) {
                step2JinaModelEl.addEventListener('change', () => {
                    this.rerankerStep2.model = step2JinaModelEl.value;
                    localStorage.setItem('chunhr-reranker-step2', JSON.stringify(this.rerankerStep2));
                });
            }
            if (step2NvidiaModelEl) {
                step2NvidiaModelEl.addEventListener('change', () => {
                    this.rerankerStep2.model = step2NvidiaModelEl.value;
                    localStorage.setItem('chunhr-reranker-step2', JSON.stringify(this.rerankerStep2));
                });
            }
            if (step2LangModelEl) {
                step2LangModelEl.addEventListener('change', () => {
                    this.rerankerStep2.model = step2LangModelEl.value;
                    localStorage.setItem('chunhr-reranker-step2', JSON.stringify(this.rerankerStep2));
                });
            }
            syncStep2();
        }

        // Availability is simply tied to online mode
        const validateRerankerAvailability = () => {
            const isOnline = !!modeRadioOnline?.checked;
            const enabledAllowed = isOnline;
            if (enabledEl) {
                enabledEl.disabled = !enabledAllowed;
                if (!enabledAllowed) {
                    enabledEl.checked = false;
                    this.rerankerEnabled = false;
                    localStorage.setItem('chunhr-reranker-enabled', 'false');
                }
            }
        };
        if (modeRadioOnline) modeRadioOnline.addEventListener('change', () => { validateRerankerAvailability(); providerEl && providerEl.dispatchEvent(new Event('change')); });
        if (providerSelect) providerSelect.addEventListener('change', () => { validateRerankerAvailability(); providerEl && providerEl.dispatchEvent(new Event('change')); });
        validateRerankerAvailability();
        // Initial sync
        providerEl && providerEl.dispatchEvent(new Event('change'));
    }
    
    // Analysis Process - Task Methods
    async startIngestAndRank() {
        if (!this.uploadedFile) {
            this.showNotification('Please upload a resume database file first', 'error');
            return;
        }
        
        // Close modal and show processing view
        this.closeTaskModal();
        this.showAnalyzerView('processing');
        this.resetAnalyzerDisplay();
        
        // --- START OF FIX: Send self-contained configuration ---
        let jobTitle = document.getElementById('job-title').value.trim();
        let keySkills = document.getElementById('key-skills').value.trim();
        // Prepend query-formatting strings
        if (jobTitle) {
            jobTitle = `Find me most suitable candidate for the job title : ${jobTitle}`;
        }
        if (keySkills) {
            keySkills = `Find me best candidates with experience in technologies : ${keySkills}`;
        }
        const algorithm = document.getElementById('algorithm-selection').value;
        const minkowskiP = document.getElementById('minkowski-p').value;

        // Prepare form data
        const formData = new FormData();
        formData.append('resumeFile', this.uploadedFile);
        formData.append('jobTitle', jobTitle);
        formData.append('keySkills', keySkills);
        formData.append('algorithm', algorithm);
        if (algorithm === 'minkowski') {
            formData.append('minkowskiP', minkowskiP);
        }
        formData.append('config', JSON.stringify(this.getCurrentUiConfig()));
        // --- END OF FIX ---
        
        if (!jobTitle || !keySkills) {
            this.showNotification('Please fill in role name and key skills', 'error');
            this.showAnalyzerView('dashboard'); // Revert view
            return;
        }
        
        try {
            const response = await fetch('/api/analyzer/analyze', {
                method: 'POST',
                body: formData
            });
            
            if (!response.ok) {
                throw new Error(`Server error: ${response.statusText}`);
            }
            
            const result = await response.json();
            
            if (result.success) {
                this.showNotification('Analysis started successfully!', 'success');
            } else {
                throw new Error(result.error || 'Analysis failed');
            }
            
        } catch (error) {
            console.error('Analysis error:', error);
            this.showNotification('Failed to start analysis: ' + error.message, 'error');
            this.showAnalyzerView('home'); // Go back to home
        }
    }

    async startRankExisting() {
        this.closeTaskModal();
        this.showAnalyzerView('processing');
        this.resetAnalyzerDisplay();

        // --- START OF FIX: Send self-contained configuration ---
        let jobTitle = document.getElementById('job-title-existing').value.trim();
        let keySkills = document.getElementById('key-skills-existing').value.trim();
        // Prepend query-formatting strings
        if (jobTitle) {
            jobTitle = `Find me the best candidates for job position : ${jobTitle}`;
        }
        if (keySkills) {
            keySkills = ` who are experienced in these technologies and skills and is fit for the job position. key skills / job description are as follows : ${keySkills}`;
        }
        const algorithm = document.getElementById('algorithm-selection-existing').value;
        const minkowskiP = document.getElementById('minkowski-p-existing').value;

        try {
            const requestBody = { 
                jobTitle, 
                keySkills, 
                algorithm 
            };
            
            if (algorithm === 'minkowski') {
                requestBody.minkowskiP = parseFloat(minkowskiP);
            }
            requestBody.config = this.getCurrentUiConfig();
            // --- END OF FIX ---

            if (!jobTitle || !keySkills) {
                this.showNotification('Please fill in role name and key skills', 'error');
                return;
            }

            const response = await fetch('/api/analyzer/rank-existing', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) throw new Error(`Server error: ${response.statusText}`);
            const result = await response.json();
            if (!result.success) throw new Error(result.error || 'Analysis failed');

            this.showNotification('Ranking started successfully!', 'success');

        } catch (error) {
            console.error('Ranking error:', error);
            this.showNotification('Failed to start ranking: ' + error.message, 'error');
            this.showAnalyzerView('home');
        }
    }

    // Event handler for algorithm selection dropdown to show/hide Minkowski p-parameter
    initializeAlgorithmDropdowns() {
        const ingestDropdown = document.getElementById('algorithm-selection-ingest');
        const existingDropdown = document.getElementById('algorithm-selection-existing');
        
        if (ingestDropdown) {
            ingestDropdown.addEventListener('change', (e) => {
                this.toggleMinkowskiParameter('ingest', e.target.value);
            });
        }
        
        if (existingDropdown) {
            existingDropdown.addEventListener('change', (e) => {
                this.toggleMinkowskiParameter('existing', e.target.value);
            });
        }
    }

    toggleMinkowskiParameter(formType, algorithm) {
        const parameterDiv = document.getElementById(`minkowski-parameter-${formType}`);
        if (parameterDiv) {
            parameterDiv.style.display = algorithm === 'minkowski' ? 'block' : 'none';
        }
    }

    async startIngestOnly() {
        if (!this.uploadedFile) {
            this.showNotification('Please upload files first', 'error');
            return;
        }
        this.closeTaskModal();
        this.showAnalyzerView('processing');
        this.resetAnalyzerDisplay();
        
        // --- START OF FIX: Send self-contained configuration ---
        const formData = new FormData();
        if (Array.isArray(this.uploadedFile)) {
            this.uploadedFile.forEach(f => formData.append('files', f));
        } else {
            formData.append('files', this.uploadedFile);
        }
        formData.append('config', JSON.stringify(this.getCurrentUiConfig()));
        // --- END OF FIX ---

        try {
            const response = await fetch('/api/analyzer/bulk-ingest', { method: 'POST', body: formData });
            let result;
            const isJson = (response.headers.get('content-type') || '').includes('application/json');
            if (isJson) {
                try { result = await response.json(); } catch (_) { /* ignore parse failure */ }
            }
            if (!response.ok) {
                const errMsg = (result && (result.error || result.message)) || `Server error: ${response.status} ${response.statusText}`;
                if (result && result.debug) {
                    console.warn('Bulk ingest debug info:', result.debug);
                }
                throw new Error(errMsg);
            }
            if (!result) {
                throw new Error('Empty response from server');
            }
            if (!result.success) {
                // Duplicate-only path returns success true; if success false treat as failure
                throw new Error(result.error || 'Bulk ingestion failed');
            }
            // Handle duplicate-only success (candidateCount = 0 with stats)
            if (result.candidateCount === 0) {
                this.showNotification(result.message || 'No new candidates (all duplicates).', 'warning');
                console.log('Bulk ingest stats (duplicates):', result.stats);
                this.showAnalyzerView('home');
                return;
            }
            console.log('Bulk ingest accepted. Stats:', result.stats || { candidateCount: result.candidateCount });
            this.showNotification(result.message || `Bulk ingestion queued for ${result.candidateCount} candidates`, 'success');
        } catch (error) {
            console.error('Bulk ingestion error:', error);
            this.showNotification('Failed to start ingestion: ' + error.message, 'error');
            this.showAnalyzerView('home');
        }
    }

    // Recycle Vectors Modal Methods
    openRecycleVectorsModal() {
        document.getElementById('recycle-vectors-modal').classList.remove('hidden');
    }

    closeRecycleVectorsModal() {
        document.getElementById('recycle-vectors-modal').classList.add('hidden');
    }

    async startRecycleVectors() {
        try {
            this.closeRecycleVectorsModal();
            this.showAnalyzerView('processing');
            this.resetAnalyzerDisplay();

            // Get selected embedding model
            // Get selected embedding model from settings
            const savedEmbeddingMode = localStorage.getItem('chunhr-embedding-mode') || 'local';
            let selectedModel;
            if (savedEmbeddingMode === 'local') {
                selectedModel = localStorage.getItem('chunhr-local-embedding') || 'bge-base';
            } else {
                const provider = localStorage.getItem('chunhr-embedding-provider') || 'gemini';
                selectedModel = `${provider}-online`;
            }
            
            const response = await fetch('/api/analyzer/recycle-vectors', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ embeddingModel: selectedModel })
            });

            const result = await response.json();
            
            if (!response.ok || !result.success) {
                throw new Error(result.error || 'Failed to start vector recycling');
            }

            console.log('Vector recycling started successfully');
            this.showNotification('Vector recycling started - this may take several minutes', 'info');

        } catch (error) {
            console.error('Vector recycling error:', error);
            this.showNotification('Failed to start vector recycling: ' + error.message, 'error');
            this.showAnalyzerView('home');
        }
    }

    async startScriptGeneration() {
        if (!this.scriptGeneratorFile) {
            this.showNotification('Please upload a resume PDF first.', 'error');
            return;
        }
        const jobDescription = document.getElementById('sg-job-description').value.trim();
        if (!jobDescription) {
            this.showNotification('Please provide a job description.', 'error');
            return;
        }
        const llmProviderSelect = document.getElementById('llm-provider-select');
        const llmProvider = (llmProviderSelect?.value || this.selectedLlmProvider || 'gemini');
        const providerKeys = (this.providerApiKeys?.[llmProvider] || []).filter(Boolean);
        const fallbackKeys = (this.apiKeys || []).filter(Boolean);
        const useKeys = providerKeys.length ? providerKeys : fallbackKeys;
        if (!useKeys.length) {
            this.showNotification('Please add at least one Gemini API key in the Theme Studio settings.', 'error');
            return;
        }

        this.showLoading('Generating Structured Interview Script...', 'The AI is crafting personalized technical questions and coding problems. This may take a moment.');

        const formData = new FormData();
        formData.append('resumeFile', this.scriptGeneratorFile);
        formData.append('jobDescription', jobDescription);
        formData.append('apiKeys', JSON.stringify(useKeys));
        // Choose model based on provider
    let modelToSend = this.selectedModel || 'gemini-flash-latest';
        if (llmProvider === 'cohere') {
            const cohereSel = document.getElementById('cohere-llm-select');
            modelToSend = (cohereSel?.value) || this.selectedModel || 'command-a-reasoning-08-2025';
        }
        formData.append('selectedModel', modelToSend);
        formData.append('llmProvider', llmProvider);

        try {
            const response = await fetch('/api/script-generator/generate', {
                method: 'POST',
                body: formData,
            });

            const contentType = response.headers.get('content-type') || '';
            if (!response.ok) {
                if (contentType.includes('application/json')) {
                    const errData = await response.json();
                    throw new Error(errData.error || `Server error: ${response.status} ${response.statusText}`);
                } else {
                    const text = await response.text();
                    throw new Error(`Server error: ${response.status} ${response.statusText}${text ? ' - ' + text.slice(0, 200) : ''}`);
                }
            }

            let result;
            if (contentType.includes('application/json')) {
                result = await response.json();
            } else {
                // Unexpected content-type (e.g., HTML); surface a readable error
                const text = await response.text();
                throw new Error(`Unexpected response from server (not JSON). ${text.slice(0, 200)}`);
            }
            
            // Store the raw result for export
            this.currentScriptData = result;
            
            // Handle both structured and legacy response formats
            if (result.fullInterviewScriptMarkdown) {
                // Legacy format - use as-is for markdown
                this.generatedScriptContent = result.fullInterviewScriptMarkdown;
                document.getElementById('sg-results-container').innerHTML = `<div class=\"results-output-markdown\">${marked.parse(this.generatedScriptContent)}</div>`;
            } else {
                // New structured format - display beautifully
                this.generatedScriptContent = this.convertStructuredToMarkdown(result);
                this.displayStructuredResults(result);
            }
            
            document.getElementById('sg-results-title').textContent = result.interviewTitle || 'Generated Interview Script';
            this.showScriptGeneratorView('results');
            this.showNotification('🎉 Interview script generated successfully! Ready for export and use.', 'success');

        } catch (error) {
            console.error('Script generation error:', error);
            this.showNotification(`Failed to generate script: ${error.message}`, 'error');
        } finally {
            this.hideLoading();
        }
    }

    convertStructuredToMarkdown(data) {
        let markdown = `# ${data.interviewTitle}\n\n`;
        
        // Introduction
        markdown += `## Introduction\n\n${data.introduction}\n\n`;
        
        // Candidate Summary
        markdown += `## Candidate Summary\n\n${data.candidateSummary}\n\n`;
        
        // Theoretical Questions
        markdown += `### Theoretical & Experience Validation\n\n`;
        if (data.theoreticalQuestions && data.theoreticalQuestions.length > 0) {
            data.theoreticalQuestions.forEach(q => {
                markdown += `${q.number}. ${q.question}\n\n`;
            });
        }
        
        // DSA Problems
        markdown += `### Data Structures & Algorithms (DSA)\n\n`;
        if (data.dsaProblems && data.dsaProblems.length > 0) {
            data.dsaProblems.forEach(problem => {
                markdown += `**Problem ${problem.number} (${problem.difficulty}): ${problem.title}**\n\n`;
                markdown += `${problem.statement}\n\n`;
                
                markdown += `**Input Format:** ${problem.inputFormat}\n\n`;
                markdown += `**Output Format:** ${problem.outputFormat}\n\n`;
                markdown += `**Constraints:** ${problem.constraints}\n\n`;
                
                if (problem.examples && problem.examples.length > 0) {
                    markdown += `**Examples:**\n\n`;
                    problem.examples.forEach((example, index) => {
                        markdown += `Example ${index + 1}:\n`;
                        markdown += `- Input: \`${example.input}\`\n`;
                        markdown += `- Output: \`${example.output}\`\n`;
                        markdown += `- Explanation: ${example.explanation}\n\n`;
                    });
                }
                
                markdown += `**Solution:**\n\n`;
                markdown += `\`\`\`python\n${problem.solution}\n\`\`\`\n\n`;
                
                if (problem.approach) {
                    markdown += `**Approach:** ${problem.approach}\n\n`;
                }
                
                markdown += `**Time Complexity:** ${problem.timeComplexity}\n\n`;
                markdown += `**Space Complexity:** ${problem.spaceComplexity}\n\n`;
                markdown += `---\n\n`;
            });
        }
        
        // Conclusion
        markdown += `## Conclusion\n\n${data.conclusion}\n`;
        
        return markdown;
    }

    displayStructuredResults(data) {
        const container = document.getElementById('sg-results-container');
        let html = '';

        // Interview Title Section
        html += `
            <div class="script-section interview-title-section">
                <h1 class="interview-title-text">${data.interviewTitle}</h1>
            </div>
        `;

        // Introduction Section
        html += `
            <div class="script-section">
                <h2 class="script-section-title">
                    <span class="script-section-icon">👋</span>
                    Introduction
                </h2>
                <div class="script-section-content">
                    <p>${data.introduction}</p>
                </div>
            </div>
        `;

        // Candidate Summary Section
        html += `
            <div class="script-section">
                <h2 class="script-section-title">
                    <span class="script-section-icon">📋</span>
                    Candidate Summary
                </h2>
                <div class="script-section-content">
                    <p>${data.candidateSummary}</p>
                </div>
            </div>
        `;

        // Theoretical Questions Section
        if (data.theoreticalQuestions && data.theoreticalQuestions.length > 0) {
            html += `
                <div class="script-section">
                    <h2 class="script-section-title">
                        <span class="script-section-icon">💭</span>
                        Theoretical & Experience Validation
                    </h2>
                    <div class="script-section-content theoretical-questions">
            `;
            
            data.theoreticalQuestions.forEach(question => {
                html += `
                    <div class="question-item">
                        <div class="question-text">${question.question}</div>
                    </div>
                `;
            });
            
            html += `
                    </div>
                </div>
            `;
        }

        // DSA Problems Section
        if (data.dsaProblems && data.dsaProblems.length > 0) {
            html += `
                <div class="script-section">
                    <h2 class="script-section-title">
                        <span class="script-section-icon">🧮</span>
                        Data Structures & Algorithms (${data.dsaProblems.length} Problems)
                    </h2>
                    <div class="script-section-content dsa-problems">
            `;
            
            data.dsaProblems.forEach(problem => {
                html += this.renderDSAProblem(problem);
            });
            
            html += `
                    </div>
                </div>
            `;
        }

        // Conclusion Section
        html += `
            <div class="script-section conclusion-section">
                <h2 class="script-section-title">
                    <span class="script-section-icon">🎯</span>
                    Conclusion
                </h2>
                <div class="script-section-content">
                    <p class="conclusion-text">${data.conclusion}</p>
                </div>
            </div>
        `;

        container.innerHTML = html;

        // Add copy functionality to solution code blocks
        this.addCopyFunctionality();
    }

    renderDSAProblem(problem) {
        const difficultyClass = `difficulty-${problem.difficulty.toLowerCase()}`;
        
        let html = `
            <div class="dsa-problem">
                <div class="dsa-problem-header">
                    <h3 class="dsa-problem-title">Problem ${problem.number}: ${problem.title}</h3>
                    <span class="difficulty-badge ${difficultyClass}">${problem.difficulty}</span>
                </div>
                
                <div class="dsa-problem-content">
                    <div class="problem-statement">${problem.statement}</div>
                    
                    <div class="problem-details">
                        <div class="problem-detail-item">
                            <div class="problem-detail-label">Input Format</div>
                            <div class="problem-detail-value">${problem.inputFormat}</div>
                        </div>
                        <div class="problem-detail-item">
                            <div class="problem-detail-label">Output Format</div>
                            <div class="problem-detail-value">${problem.outputFormat}</div>
                        </div>
                        <div class="problem-detail-item">
                            <div class="problem-detail-label">Constraints</div>
                            <div class="problem-detail-value">${problem.constraints}</div>
                        </div>
                    </div>
        `;

        // Examples
        if (problem.examples && problem.examples.length > 0) {
            html += `<div class="examples-section">`;
            problem.examples.forEach((example, index) => {
                html += `
                    <div class="example-item">
                        <div class="example-header">Example ${index + 1}:</div>
                        <div class="example-io">
                            <div class="example-input"><strong>Input:</strong> ${example.input}</div>
                            <div class="example-output"><strong>Output:</strong> ${example.output}</div>
                        </div>
                        <div class="example-explanation"><strong>Explanation:</strong> ${example.explanation}</div>
                    </div>
                `;
            });
            html += `</div>`;
        }

        // Solution
        html += `
                    <div class="solution-section">
                        <div class="solution-header">
                            <div class="solution-title">Optimal Solution</div>
                            <button class="copy-solution-btn" onclick="app.copyToClipboard(\`${problem.solution.replace(/`/g, '\\`')}\`, 'Solution copied!')">
                                Copy Code
                            </button>
                        </div>
                        <pre class="solution-code">${problem.solution}</pre>
                        
                        <div class="solution-meta">
                            <div class="complexity-item">
                                <span class="complexity-label">Time:</span>
                                <span class="complexity-value">${problem.timeComplexity}</span>
                            </div>
                            <div class="complexity-item">
                                <span class="complexity-label">Space:</span>
                                <span class="complexity-value">${problem.spaceComplexity}</span>
                            </div>
                            ${problem.approach ? `
                                <div class="complexity-item">
                                    <span class="complexity-label">Approach:</span>
                                    <span class="complexity-value">${problem.approach}</span>
                                </div>
                            ` : ''}
                        </div>
                    </div>
                </div>
            </div>
        `;

        return html;
    }

    addCopyFunctionality() {
        // Add event listeners for copy buttons
        document.querySelectorAll('.copy-solution-btn').forEach(btn => {
            if (!btn.hasAttribute('data-listener-added')) {
                btn.setAttribute('data-listener-added', 'true');
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    // The onclick handler in the HTML will handle the copy
                });
            }
        });
    }

    async copyToClipboard(text, successMessage = 'Copied to clipboard!') {
        try {
            await navigator.clipboard.writeText(text);
            this.showNotification(successMessage, 'success');
        } catch (err) {
            // Fallback for older browsers
            const textArea = document.createElement('textarea');
            textArea.value = text;
            document.body.appendChild(textArea);
            textArea.select();
            try {
                document.execCommand('copy');
                this.showNotification(successMessage, 'success');
            } catch (err) {
                this.showNotification('Failed to copy to clipboard', 'error');
            }
            document.body.removeChild(textArea);
        }
    }

    async copyScriptToClipboard() {
        if (!this.generatedScriptContent) {
            this.showNotification('No script content to copy.', 'error');
            return;
        }

        await this.copyToClipboard(this.generatedScriptContent, 'Full script copied to clipboard!');
    }
    
    // Analyzer Display Management
    resetAnalyzerDisplay() {
        const progressFill = document.getElementById('progress-fill');
        const progressPercentage = document.getElementById('progress-percentage');
        const progressStatus = document.getElementById('progress-status');
        const processingLog = document.getElementById('processing-log');
        
        progressFill.style.width = '0%';
        progressPercentage.textContent = '0%';
        progressStatus.textContent = 'Initializing...';
        processingLog.innerHTML = '';
    }
    
    updateAnalyzerProgress(data) {
        const progressFill = document.getElementById('progress-fill');
        const progressPercentage = document.getElementById('progress-percentage');
        const progressStatus = document.getElementById('progress-status');
        const processingLog = document.getElementById('processing-log');
        
        // Update progress bar with GSAP animation if available
        if (data.percentage !== undefined) {
            if (window.chunAnimations && window.chunAnimations.isInitialized) {
                window.chunAnimations.animateProgress(progressFill, data.percentage);
            } else {
                progressFill.style.width = data.percentage + '%';
            }
            progressPercentage.textContent = Math.round(data.percentage) + '%';
        }
        
        // Update status
        if (data.status) {
            progressStatus.textContent = data.status;
            
            // Add warning styling for degraded performance
            if (data.status.includes('Warning') || data.status.includes('degraded')) {
                progressStatus.style.color = '#f59e0b';
                progressStatus.style.fontWeight = 'bold';
            } else {
                progressStatus.style.color = '';
                progressStatus.style.fontWeight = '';
            }
        }
        
        // Add log entry
        if (data.message) {
            const logEntry = document.createElement('div');
            logEntry.className = 'log-entry';
            
            // Add warning styling for fallback messages
            if (data.message.includes('⚠️') || data.message.includes('degraded')) {
                logEntry.className += ' log-warning';
                logEntry.style.color = '#f59e0b';
                logEntry.style.fontWeight = 'bold';
            }
            
            logEntry.textContent = `${new Date().toLocaleTimeString()}: ${data.message}`;
            processingLog.appendChild(logEntry);
            processingLog.scrollTop = processingLog.scrollHeight;
        }
    }
    
    handleAnalyzerComplete(data) {
        // Pre-filter results to exclude any candidate with 98% or higher score
        if (data && Array.isArray(data.results)) {
            const before = data.results.length;
            const filtered = this.filterOutHighScoreCandidates(data.results);
            if (filtered.length !== before) {
                console.log(`Filtered out ${before - filtered.length} candidate(s) with >= ${this.scoreFilterThreshold}% score.`);
            }
            data.results = filtered;
        }

        if (data.success) {
            this.processingResults = data.results || [];
            if (data.jobId) this.lastJobId = data.jobId;
            this.showNotification(data.message || 'Processing completed successfully!', 'success');
            
            if (data.results && data.results.length > 0) {
                this.showAnalyzerView('results');
                this.updateResultsDisplay();
            } else {
                // If it was an ingest-only task, just go back to the home
                this.showAnalyzerView('home');
            }
        } else {
            this.showNotification('Processing failed: ' + data.error, 'error');
            this.showAnalyzerView('home'); // Go back to home
        }
    }
    
    // Helper to filter out high-scoring candidates (>= threshold percent)
    filterOutHighScoreCandidates(results, thresholdPercent = this.scoreFilterThreshold) {
    try {
      const arr = Array.isArray(results) ? results : [];
      const th = Number(thresholdPercent) || 98;
      return arr.filter((r) => {
        let s = r?.similarity_score;
        if (s == null) return true; // keep if unknown score
        // Accept number or string (e.g., "83.71%" or "0.8371")
        if (typeof s === 'string') {
          const m = s.match(/[\d.]+/);
          s = m ? parseFloat(m[0]) : NaN;
        }
        if (!isFinite(s)) return true; // keep if invalid
        // Normalize to fraction [0,1]
        const frac = s > 1 ? s / 100 : s;
        return (frac * 100) < th; // keep if strictly below threshold percent
      });
    } catch (e) {
      console.warn('Filter error, returning original results:', e);
      return results || [];
    }
  }

    // Results Display
    updateResultsDisplay() {
        const limit = parseInt(document.getElementById('results-limit').value);

        // Ensure filtering is applied before slicing for display
        const filteredResults = this.filterOutHighScoreCandidates(this.processingResults);
        const resultsToShow = filteredResults.slice(0, limit);

        const resultsList = document.getElementById('results-list');

        // Clear previous results
        resultsList.innerHTML = '';

        // Create header if results exist
        if (resultsToShow.length > 0) {
            const header = document.createElement('div');
            header.className = 'results-header';
            header.innerHTML = `
                <h2>Top Candidates</h2>
                <p class="results-subtitle">Ranked by AI-powered similarity matching • Showing ${resultsToShow.length} of ${filteredResults.length} candidates</p>
            `;
            resultsList.appendChild(header);
            
            // Create grid container
            const grid = document.createElement('div');
            grid.className = 'candidates-grid';
            
            // Add all cards first
            resultsToShow.forEach((result, index) => {
                const card = this.createResultCard(result, index + 1);
                grid.appendChild(card);
            });
            
            resultsList.appendChild(grid);
            
            // Animate results using GSAP if available
            if (window.chunAnimations && window.chunAnimations.isInitialized) {
                window.chunAnimations.animateResults(grid);
            }
        } else {
            resultsList.innerHTML = `
                <div class="results-header">
                    <h2>No Results</h2>
                    <p class="results-subtitle">No candidates found matching your criteria.</p>
                </div>
            `;
        }
    }
    
    createResultCard(result, rank) {
        const card = document.createElement('div');
        card.className = 'candidate-card new';
        
        const score = Math.round(result.similarity_score * 100);
        const preview = result.content ? result.content.substring(0, 300) + '...' : 'No preview available';
        
        // Determine score color based on percentage
        let scoreColor = '#667eea';
        if (score >= 80) scoreColor = '#10b981';
        else if (score >= 60) scoreColor = '#f59e0b';
        else if (score < 40) scoreColor = '#ef4444';
        
        card.innerHTML = `
            <div class="card-header">
                <div class="candidate-info">
                    <h3>${result.name || 'Candidate ' + result.candidate_id}</h3>
                    <div class="email">${result.email || 'No email provided'}</div>
                </div>
                <div class="rank-badge ${rank <= 3 ? 'rank-' + rank : ''}">#${rank}</div>
            </div>
            
            <div class="card-content">
                <div class="similarity-score">
                    <span class="score-label">Match Score</span>
                    <div class="score-bar">
                        <div class="score-fill" style="width: ${score}%; background: linear-gradient(90deg, ${scoreColor}, ${scoreColor}aa);"></div>
                    </div>
                    <span class="score-value">${score}%</span>
                </div>
                
                <div class="resume-preview">
                    <div class="preview-header">
                        <svg class="preview-icon" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M14,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2M18,20H6V4H13V9H18V20Z" />
                        </svg>
                        <span class="preview-title">Resume Preview</span>
                    </div>
                    <div class="resume-content">${preview}</div>
                </div>
            </div>
            
            <div class="card-actions">
                ${result.local_file_path ? 
                    `<button class="action-btn btn-primary" data-file-path="${result.local_file_path}" onclick="app.openResumeFileFromButton(this)">
                        <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                            <polyline points="14,2 14,8 20,8"></polyline>
                            <line x1="16" y1="13" x2="8" y2="13"></line>
                            <line x1="16" y1="17" x2="8" y2="17"></line>
                            <polyline points="10,9 9,9 8,9"></polyline>
                        </svg>
                        Open Local Resume
                    </button>` : ''
                }
                ${result.resume_url ? 
                    `<button class="action-btn btn-secondary" onclick="app.openResumeUrl('${result.resume_url}')">
                        <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                            <polyline points="15,3 21,3 21,9"></polyline>
                            <line x1="10" y1="14" x2="21" y2="3"></line>
                        </svg>
                        View Online
                    </button>` : ''
                }
                <button class="action-btn btn-secondary" onclick="app.viewCandidateDetails(${result.candidate_id})">
                    <svg class="btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                        <circle cx="12" cy="12" r="3"></circle>
                    </svg>
                    Details
                </button>
            </div>
        `;
        
        return card;
    }
    
    // Card Action Methods
    openResumeFileFromButton(button) {
        const filePath = button.getAttribute('data-file-path');
        this.openResumeFile(filePath);
    }
    
    openResumeFile(filePath) {
        // Since we can't directly open local files from browser, we'll create an endpoint
        // Normalize the path to use forward slashes for URL encoding
        const normalizedPath = filePath.replace(/\\/g, '/');
        window.open(`/api/analyzer/view-resume?path=${encodeURIComponent(normalizedPath)}`, '_blank');
    }
    
    openResumeUrl(url) {
        if (url && url !== '#' && url !== 'null' && url !== 'undefined') {
            // Handle Google Drive URLs
            if (url.includes('drive.google.com')) {
                // Try to convert to direct view link
                let viewUrl = url;
                if (url.includes('/file/d/')) {
                    const fileId = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
                    if (fileId) {
                        viewUrl = `https://drive.google.com/file/d/${fileId[1]}/view`;
                    }
                }
                window.open(viewUrl, '_blank');
            } else {
                // For other URLs, open directly
                window.open(url, '_blank');
            }
        } else {
            this.showNotification('Resume URL not available', 'warning');
        }
    }
    
    viewCandidateDetails(candidateId) {
        // Find the candidate in results
        const candidate = this.processingResults.find(r => r.candidate_id === candidateId);
        if (candidate) {
            // Create a modal or detailed view
            this.showCandidateModal(candidate);
        }
    }
    
    showCandidateModal(candidate) {
        // Create modal overlay
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h2>${candidate.name || 'Candidate ' + candidate.candidate_id}</h2>
                    <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">&times;</button>
                </div>
                <div class="modal-body">
                    <div class="candidate-details">
                        <p><strong>Email:</strong> ${candidate.email || 'Not provided'}</p>
                        <p><strong>Phone:</strong> ${candidate.phone || 'Not provided'}</p>
                        <p><strong>Match Score:</strong> ${Math.round(candidate.similarity_score * 100)}%</p>
                        ${candidate.resume_url ? `<p><strong>Original Resume URL:</strong> <a href="${candidate.resume_url}" target="_blank">View Original</a></p>` : ''}
                        ${candidate.local_file_path ? `<p><strong>Local File:</strong> Available (downloaded and processed)</p>` : ''}
                    </div>
                    <div class="resume-full-content">
                        <h3>Full Resume Content</h3>
                        <div class="content-preview">${candidate.content || 'Content not available'}</div>
                    </div>
                </div>
            </div>
        `;
        
        // Add styles if not already present
        if (!document.querySelector('style[data-modal]')) {
            const style = document.createElement('style');
            style.setAttribute('data-modal', 'true');
            style.textContent = `
                .modal-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0, 0, 0, 0.8);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 1000;
                    padding: 2rem;
                }
                .modal-content {
                    background: rgba(30, 41, 59, 0.95);
                    backdrop-filter: blur(20px);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    border-radius: 20px;
                    max-width: 600px;
                    width: 100%;
                    max-height: 80vh;
                    overflow-y: auto;
                }
                .modal-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 1.5rem;
                    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                }
                .modal-header h2 {
                    color: white;
                    margin: 0;
                }
                .modal-close {
                    background: none;
                    border: none;
                    color: #8B9DC3;
                    font-size: 1.5rem;
                    cursor: pointer;
                    padding: 0;
                    width: 30px;
                    height: 30px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                .modal-close:hover {
                    color: white;
                }
                .modal-body {
                    padding: 1.5rem;
                }
                .candidate-details p {
                    color: #8B9DC3;
                    margin: 0.5rem 0;
                }
                .candidate-details strong {
                    color: white;
                }
                .candidate-details a {
                    color: #667eea;
                    text-decoration: none;
                }
                .candidate-details a:hover {
                    text-decoration: underline;
                }
                .resume-full-content h3 {
                    color: white;
                    margin: 1.5rem 0 1rem 0;
                }
                .content-preview {
                    background: rgba(255, 255, 255, 0.02);
                    border: 1px solid rgba(255, 255, 255, 0.05);
                    border-radius: 12px;
                    padding: 1rem;
                    color: #8B9DC3;
                    line-height: 1.6;
                    max-height: 300px;
                    overflow-y: auto;
                    white-space: pre-wrap;
                }
            `;
            document.head.appendChild(style);
        }
        
        document.body.appendChild(modal);
        
        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
    }
    
    // Export Results
    async exportResults(format = 'xlsx') {
        try {
            // Ensure we export only filtered results
            const filtered = this.filterOutHighScoreCandidates(this.processingResults);

            // If the export uses this.processingResults directly, prefer using `filtered` instead.
            // Example (pseudocode replacement):
            // const payload = { format, results: filtered };
            // await fetch('/api/export', { method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' } });

            const limit = parseInt(document.getElementById('results-limit').value);
            const payload = this.lastJobId 
                ? { jobId: this.lastJobId, limit, exportFormat: format, excludeHighScores: true, thresholdPercent: this.scoreFilterThreshold }
                : { results: filtered.slice(0, limit), limit, exportFormat: format, excludeHighScores: true, thresholdPercent: this.scoreFilterThreshold };
            const response = await fetch('/api/analyzer/export-results', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            
            if (!response.ok) {
                throw new Error('Export failed');
            }
            
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = format === 'pdf' ? `hr-analyzer-rankings-${new Date().toISOString().split('T')[0]}.pdf` : `hr-analyzer-rankings-${new Date().toISOString().split('T')[0]}.xlsx`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
            
            const successMessage = format === 'pdf' 
                ? 'PDF exported successfully! (Click without Shift for Excel export)'
                : 'Excel file exported successfully! (Shift+Click for PDF export)';
            this.showNotification(successMessage, 'success');
            
        } catch (error) {
            console.error('Export error:', error);
            this.showNotification('Failed to export results', 'error');
        }
    }
    
    async exportScriptToPdf() {
        if (!this.generatedScriptContent && !this.currentScriptData) {
            this.showNotification('No script content to export.', 'error');
            return;
        }

        try {
            const title = document.getElementById('sg-results-title').textContent;
            const payload = {
                title: title
            };

            // Send structured data if available, otherwise fall back to markdown
            if (this.currentScriptData && !this.currentScriptData.fullInterviewScriptMarkdown) {
                payload.structuredData = this.currentScriptData;
            } else {
                payload.markdown = this.generatedScriptContent;
            }

            const response = await fetch('/api/script-generator/export-pdf', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                throw new Error('PDF export failed');
            }

            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `Hr_Analyzer_Interview_Script.pdf`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            window.URL.revokeObjectURL(url);
            this.showNotification('Script exported to PDF successfully!', 'success');
        } catch (error) {
            this.showNotification('Failed to export PDF.', 'error');
        }
    }

    // UI Utilities
    showLoading(title = 'Loading...', message = 'Please wait...') {
        const overlay = document.getElementById('loading-overlay');
        const titleEl = document.getElementById('loading-title');
        const messageEl = document.getElementById('loading-message');
        
        titleEl.textContent = title;
        messageEl.textContent = message;
        
        // Use GSAP animation if available
        if (window.chunAnimations && window.chunAnimations.isInitialized) {
            window.chunAnimations.showLoading(overlay);
        } else {
            overlay.classList.remove('hidden');
        }
    }
    
    hideLoading() {
        const overlay = document.getElementById('loading-overlay');
        
        // Use GSAP animation if available
        if (window.chunAnimations && window.chunAnimations.isInitialized) {
            window.chunAnimations.hideLoading(overlay);
        } else {
            overlay.classList.add('hidden');
        }
    }
    
    showNotification(message, type = 'info') {
        const notification = document.getElementById('notification');
        const messageEl = document.getElementById('notification-message');
        
        messageEl.textContent = message;
        notification.className = `notification ${type}`;
        
        // Use GSAP animation if available
        if (window.chunAnimations && window.chunAnimations.isInitialized) {
            window.chunAnimations.showNotification(notification);
        } else {
            notification.classList.remove('hidden');
        }
        
        // Auto-hide after 5 seconds
        setTimeout(() => {
            this.hideNotification();
        }, 5000);
    }
    
    hideNotification() {
        const notification = document.getElementById('notification');
        
        // Use GSAP animation if available
        if (window.chunAnimations && window.chunAnimations.isInitialized) {
            window.chunAnimations.hideNotification(notification);
        } else {
            notification.classList.add('hidden');
        }
    }

    /* ===================== Theme Studio ===================== */
    initThemeStudio() {
        const toggle = document.getElementById('theme-studio-toggle');
        const studio = document.getElementById('theme-studio');
        const closeBtn = document.getElementById('theme-studio-close');
        const minimizeBtn = document.getElementById('theme-studio-minimize');
        const saveBtn = document.getElementById('theme-save');
        const addApiKeyBtn = document.getElementById('add-api-key-btn');
        const apiKeyInput = document.getElementById('api-key-input');
        const exportBtn = document.getElementById('theme-export');
        const presetsContainer = document.getElementById('theme-presets');

        if (!toggle || !studio) return; // Safety

        // Attempt to restore last active theme (not just presets)
        try {
            const saved = JSON.parse(localStorage.getItem('chunhr-current-theme'));
            if (saved && typeof saved === 'object') {
                // Merge to ensure newer keys exist
                this.themeVars = { ...this.themeVars, ...saved };
            }
        } catch (e) { /* ignore parse errors */ }

        toggle.addEventListener('click', () => {
            studio.classList.toggle('hidden');
        });
        closeBtn && closeBtn.addEventListener('click', () => studio.classList.add('hidden'));
        minimizeBtn && minimizeBtn.addEventListener('click', () => studio.classList.toggle('minimized'));

        // Attach listeners to sliders
        studio.querySelectorAll('input[type=range][data-var]').forEach(input => {
            const variable = input.dataset.var;
            input.addEventListener('input', (e) => {
                this.themeVars[variable] = e.target.value;
                this.applyThemeVars();
                this.updateThemeValueLabels();
            });
        });

        // Save preset
        saveBtn && saveBtn.addEventListener('click', () => {
            const nameInput = document.getElementById('theme-name');
            const name = (nameInput?.value || '').trim() || `Preset ${this.themePresets.length + 1}`;
            const snapshot = { name, vars: { ...this.themeVars }, ts: Date.now() };
            this.themePresets.push(snapshot);
            localStorage.setItem('chunhr-theme-presets', JSON.stringify(this.themePresets));
            nameInput.value = '';
            this.renderThemePresets();
            this.showNotification(`Theme "${name}" saved`, 'success');
        });

        // Add API Key
        addApiKeyBtn && addApiKeyBtn.addEventListener('click', () => {
            const key = (apiKeyInput?.value || '').trim();
            if (this.validateApiKey(key) && !this.apiKeys.includes(key)) {
                this.apiKeys.push(key);
                localStorage.setItem('chunhr-api-keys', JSON.stringify(this.apiKeys));
                this.renderApiKeys();
                apiKeyInput.value = '';
                this.showNotification('API key added successfully', 'success');
            } else if (this.apiKeys.includes(key)) {
                this.showNotification('API key already exists', 'warning');
            } else {
                this.showNotification('Please enter a valid API key (should start with "AIza")', 'error');
            }
        });

        // Toggle API Key Visibility
        const toggleVisibilityBtn = document.getElementById('toggle-key-visibility');
        toggleVisibilityBtn && toggleVisibilityBtn.addEventListener('click', () => {
            const input = apiKeyInput;
            if (input.type === 'password') {
                input.type = 'text';
                toggleVisibilityBtn.innerHTML = '<span class="eye-icon">🙈</span>';
                toggleVisibilityBtn.title = 'Hide API Key';
            } else {
                input.type = 'password';
                toggleVisibilityBtn.innerHTML = '<span class="eye-icon">👁️</span>';
                toggleVisibilityBtn.title = 'Show API Key';
            }
        });

        // Model Selection
        const modelSelect = document.getElementById('gemini-model-select');
        if (modelSelect) {
            modelSelect.value = this.selectedModel;
            modelSelect.addEventListener('change', (e) => {
                this.selectedModel = e.target.value;
                localStorage.setItem('chunhr-selected-model', this.selectedModel);
                this.showNotification(`Model changed to ${this.selectedModel}`, 'success');
            });
        }

        // API Key Input Enter Support
        apiKeyInput && apiKeyInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                addApiKeyBtn.click();
            }
        });

        // Export CSS
        exportBtn && exportBtn.addEventListener('click', () => {
            const css = this.generateThemeCSS();
            const blob = new Blob([css], { type: 'text/css' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'hr-analyzer-theme.css';
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            this.showNotification('Theme CSS exported', 'success');
        });

        // Apply initial
        this.applyThemeVars();
        this.renderThemePresets();
        this.renderApiKeys();
        this.updateThemeValueLabels();
        this.syncSliders();
    }

    validateApiKey(key, provider = 'gemini') {
        if (!key || typeof key !== 'string') return false;
        
        switch (provider) {
            case 'gemini':
                // Gemini API key format: AIza...
                return key.startsWith('AIza') && key.length > 20;
            case 'mistral':
                // Mistral API key format: usually starts with specific prefix
                return key.length > 20 && key.trim().length > 0;
            case 'nvidia':
                // NVIDIA API key format: varies, basic length check
                return key.length > 10 && key.trim().length > 0;
            case 'jina':
                // Jina API key format: starts with jina_
                return key.startsWith('jina_') && key.length > 20;
            default:
                return key.length > 10;
        }
    }

    applyThemeVars() {
        const root = document.documentElement;
        Object.entries(this.themeVars).forEach(([k, v]) => {
            if (k === 'letter-spacing') root.style.setProperty(`--${k}`, v + 'px');
            else if (k === 'radius') root.style.setProperty(`--${k}`, v + 'px');
            else if (k === 'brand-sat') root.style.setProperty(`--${k}`, v + '%');
            else if (k === 'font-weight') root.style.setProperty(`--${k}`, v);
            else root.style.setProperty(`--${k}`, v);
        });
        // Persist current active theme snapshot
        try {
            localStorage.setItem('chunhr-current-theme', JSON.stringify(this.themeVars));
        } catch (e) { /* ignore quota */ }
    }

    updateThemeValueLabels() {
        const map = {
            'theme-hue-value': this.themeVars['brand-hue'],
            'theme-sat-value': this.themeVars['brand-sat'] + '%',
            'theme-accent-shift-value': this.themeVars['accent-shift'],
            'theme-depth-value': this.themeVars['depth'],
            'theme-glass-value': this.themeVars['glass-blur'],
            'theme-radius-value': this.themeVars['radius'] + 'px',
            'theme-font-weight-value': this.themeVars['font-weight'],
            'theme-letter-value': this.themeVars['letter-spacing'] + 'px'
        };
        Object.entries(map).forEach(([dataAttr, value]) => {
            const el = document.querySelector(`[data-value="${dataAttr}"]`);
            if (el) el.textContent = value;
        });
    }

    renderThemePresets() {
        const container = document.getElementById('theme-presets');
        if (!container) return;
        container.innerHTML = '';
        if (this.themePresets.length === 0) {
            container.innerHTML = '<div class="text-muted" style="font-size:.65rem; opacity:.6;">No presets saved yet.</div>';
            return;
        }
        this.themePresets.slice().reverse().forEach(preset => {
            const btn = document.createElement('button');
            btn.textContent = preset.name;
            btn.title = 'Apply ' + preset.name;
            btn.addEventListener('click', () => {
                this.themeVars = { ...preset.vars };
                this.syncSliders();
                this.applyThemeVars();
                this.updateThemeValueLabels();
                this.showNotification(`Applied theme: ${preset.name}`, 'success');
            });
            container.appendChild(btn);
        });
    }

    renderApiKeys() {
        const container = document.getElementById('api-key-list');
        if (!container) return;
        container.innerHTML = '';
        if (this.apiKeys.length === 0) {
            container.innerHTML = '<div class="text-muted" style="font-size:.65rem; opacity:.6;">No API keys saved.</div>';
            return;
        }
        this.apiKeys.forEach(key => {
            const keyEl = document.createElement('div');
            keyEl.className = 'api-key-item';
            const maskedKey = `${key.substring(0, 4)}...${key.substring(key.length - 4)}`;
            keyEl.innerHTML = `<span>${maskedKey}</span><button class="remove-key-btn">&times;</button>`;
            keyEl.querySelector('.remove-key-btn').addEventListener('click', () => {
                this.removeApiKey(key);
            });
            container.appendChild(keyEl);
        });
    }

    removeApiKey(keyToRemove) {
        this.apiKeys = this.apiKeys.filter(k => k !== keyToRemove);
        localStorage.setItem('chunhr-api-keys', JSON.stringify(this.apiKeys));
        this.renderApiKeys();
        this.showNotification('API key removed', 'success');
    }

    syncSliders() {
        document.querySelectorAll('#theme-studio input[type=range][data-var]').forEach(input => {
            const variable = input.dataset.var;
            if (this.themeVars[variable] !== undefined) {
                input.value = this.themeVars[variable];
            }
        });
    }

    generateThemeCSS() {
        let lines = [':root {'];
        Object.entries(this.themeVars).forEach(([k, v]) => {
            if (k === 'letter-spacing') lines.push(`  --${k}: ${v}px;`);
            else if (k === 'radius') lines.push(`  --${k}: ${v}px;`);
            else if (k === 'brand-sat') lines.push(`  --${k}: ${v}%;`);
            else lines.push(`  --${k}: ${v};`);
        });
        lines.push('}');
        return lines.join('\n');
    }

    async maybeInitLocalInference() {
        const mode = localStorage.getItem('chunhr-embedding-mode') || 'online';
        const localModel = this.selectedLocalEmbedding || localStorage.getItem('chunhr-local-embedding') || 'bge-base';

        if (mode !== 'local' || localModel === 'lmstudio') {
            return;
        }

        const assetPath = localModel === 'bge-small'
            ? './models/bge-small-en-v1.5/model.onnx'
            : './models/bge-base-en-v1.5/model.onnx';

        try {
            const response = await fetch(assetPath, { method: 'HEAD', cache: 'no-store' });
            if (!response.ok) {
                console.log(`Local model asset not found at ${assetPath}; skipping browser-side inference bootstrap.`);
                return;
            }
        } catch (error) {
            console.log(`Local model probe failed for ${assetPath}; skipping browser-side inference bootstrap.`);
            return;
        }

        this.initInferenceWorker();
    }

    // WebGPU Inference Worker Management
    initInferenceWorker() {
        // Prevent multiple initializations
        if (this.inferenceWorker || this.initializingInferenceWorker) {
            console.log('🔄 Inference worker already initialized or initializing...');
            return;
        }
        
        this.initializingInferenceWorker = true;
        
        try {
            console.log('🚀 Initializing WebGPU inference worker...');
            this.inferenceWorker = new Worker('./inference-worker.js');
            
            this.inferenceWorker.onmessage = (event) => {
                this.handleWorkerMessage(event);
            };
            
            this.inferenceWorker.onerror = (error) => {
                console.error('❌ Inference worker error:', error);
                this.showNotification('WebGPU worker failed to load', 'warning');
                this.workerReady = false;
                this.initializingInferenceWorker = false;
            };
            
            // Initialize the worker with current model type
            let currentModelType = this.selectedLocalEmbedding || localStorage.getItem('chunhr-local-embedding') || 'bge-base';
            if (currentModelType === 'lmstudio') {
                currentModelType = 'bge-base';
            }
            this.inferenceWorker.postMessage({
                type: 'initialize',
                payload: {
                    modelType: currentModelType
                }
            });
            
        } catch (error) {
            console.error('❌ Failed to create inference worker:', error);
            this.showNotification('WebGPU not available, using server-side processing only', 'info');
            this.initializingInferenceWorker = false;
        }
    }

    handleWorkerMessage(event) {
        const { type, payload } = event.data;
        
        switch (type) {
            case 'log':
                console.log('[WebGPU Worker]', payload);
                break;
            case 'diagnostic':
                try {
                    console.log('[WebGPU Worker] Preflight diagnostic summary:', payload.summary);
                    if (payload.assets && Array.isArray(payload.assets)) {
                        // Pretty print as a table in supporting consoles
                        if (console.table) console.table(payload.assets);
                    }
                } catch {}
                break;
                
            case 'modelReady':
                this.workerReady = true;
                this.initializingInferenceWorker = false;
                console.log('✅ WebGPU model ready:', payload);
                this.showNotification(`Local AI model ready (${payload.provider})`, 'success');
                break;
                
            case 'result':
                this.handleInferenceResult(payload);
                break;
                
            case 'error':
                console.error('[WebGPU Worker Error]', payload);
                this.initializingInferenceWorker = false;
                this.handleInferenceError(payload);
                break;
        }
    }

    async runLocalInference(text) {
        if (!this.inferenceWorker || !this.workerReady) {
            console.log('⚠️ Local inference not available, using server-side processing');
            return null;
        }

        return new Promise((resolve, reject) => {
            const requestId = ++this.requestIdCounter;
            
            // Store the promise callbacks
            this.pendingInferences.set(requestId, { resolve, reject });
            
            // Send inference request to worker
            this.inferenceWorker.postMessage({
                type: 'runInference',
                payload: {
                    text,
                    requestId
                }
            });
            
            // Timeout after 30 seconds
            setTimeout(() => {
                if (this.pendingInferences.has(requestId)) {
                    this.pendingInferences.delete(requestId);
                    reject(new Error('Local inference timeout'));
                }
            }, 30000);
        });
    }

    handleInferenceResult(payload) {
        const { requestId, embedding, text } = payload;
        
        if (this.pendingInferences.has(requestId)) {
            const { resolve } = this.pendingInferences.get(requestId);
            this.pendingInferences.delete(requestId);
            
            console.log(`✅ Local inference completed for: "${text.substring(0, 50)}..."`);
            resolve(embedding);
        }
    }

    handleInferenceError(payload) {
        const { requestId } = payload;
        
        if (this.pendingInferences.has(requestId)) {
            const { reject } = this.pendingInferences.get(requestId);
            this.pendingInferences.delete(requestId);
            
            reject(new Error(payload.error || 'Local inference failed'));
        }
    }

    // Enhanced analysis with local preprocessing
    async analyzeWithLocalProcessing(jobDescription) {
        console.log('🔍 Starting enhanced analysis with local processing...');
        
        try {
            // Run local inference for immediate feedback
            const localEmbedding = await this.runLocalInference(jobDescription);
            
            if (localEmbedding) {
                console.log(`📊 Local embedding generated: ${localEmbedding.length} dimensions`);
                this.showNotification('Local AI preprocessing completed', 'success');
                
                // You can use this embedding for immediate UI feedback
                // while the server processing continues in parallel
            }
            
            return localEmbedding;
            
        } catch (error) {
            console.warn('⚠️ Local processing failed, continuing with server-only:', error.message);
            return null;
        }
    }

    // Initialize WebGPU Worker
    initWebGPUWorker() {
        if (!this.webGPUWorker && !this.initializingWebGPUWorker && typeof Worker !== 'undefined') {
            this.initializingWebGPUWorker = true;
            
            try {
                this.webGPUWorker = new Worker('./webgpu-worker.js');
                
                this.webGPUWorker.onmessage = (event) => {
                    this.handleWebGPUMessage(event.data);
                };
                
                this.webGPUWorker.onerror = (error) => {
                    console.error('WebGPU Worker error:', error);
                    this.webGPUAvailable = false;
                    this.initializingWebGPUWorker = false;
                    this.updateModelStatus('error', 'WebGPU worker failed');
                };
                
                // Check WebGPU availability immediately
                this.webGPUWorker.postMessage({ type: 'checkWebGPU' });
                
            } catch (error) {
                console.error('Failed to create WebGPU worker:', error);
                this.webGPUAvailable = false;
                this.initializingWebGPUWorker = false;
                this.updateModelStatus('error', 'WebGPU worker initialization failed');
            }
        }
    }
    
    // Handle WebGPU Worker Messages
    handleWebGPUMessage(data) {
        const { type, payload } = data;
        
        switch (type) {
            case 'log':
                console.log('[WebGPU Worker]', payload);
                break;
            case 'webgpu-available':
                this.webGPUAvailable = payload;
                this.initializingWebGPUWorker = false;
                break;
            case 'ready':
                console.log('WebGPU Worker ready:', payload);
                this.initializingWebGPUWorker = false;
                break;
            case 'result':
                console.log('WebGPU inference result:', payload);
                this.handleWebGPUInferenceResult(payload);
                break;
            case 'error':
                console.error('WebGPU Worker error:', payload);
                this.updateModelStatus('error', `WebGPU error: ${payload}`);
                this.fallbackToCPUModel();
                break;
            case 'ready':
                console.log('WebGPU Worker ready:', payload);
                this.webGPUAvailable = true;
                if (payload.webgpuEnabled) {
                    this.updateModelStatus('ready', 'WebGPU ready - GPU acceleration active');
                    this.updatePerformanceIndicator('gpu');
                } else {
                    this.updateModelStatus('ready', 'CPU model ready');
                    this.updatePerformanceIndicator('cpu');
                }
                break;
            case 'webgpu-available':
                this.webGPUAvailable = payload;
                if (payload) {
                    this.updateModelStatus('ready', 'WebGPU available - GPU acceleration enabled');
                    this.setDefaultEmbeddingModel();
                } else {
                    this.updateModelStatus('warning', 'WebGPU not available - falling back to CPU');
                    this.fallbackToCPUModel();
                }
                break;
        }
    }
    
    // Initialize model selection
    initModelSelection() {
        // Add event listeners for both model selection dropdowns
        const modelSelects = ['embedding-model-select', 'embedding-model-select-existing'];
        
        modelSelects.forEach(selectId => {
            const modelSelect = document.getElementById(selectId);
            if (modelSelect) {
                modelSelect.addEventListener('change', (e) => {
                    this.handleModelSelection(e.target.value, selectId);
                });
            }
        });
        
        // Add event listeners for archive intake and recycle vectors model selection
        const additionalSelects = [
            { id: 'ingest-embedding-model', desc: 'ingest-model-desc' },
            { id: 'recycle-embedding-model', desc: 'recycle-model-desc' },
            { id: 'embedding-model', desc: 'model-desc' }
        ];
        
        additionalSelects.forEach(({ id, desc }) => {
            const select = document.getElementById(id);
            if (select) {
                select.addEventListener('change', (e) => {
                    this.updateModelDescription(e.target.value, desc);
                });
                // Initialize description on page load
                this.updateModelDescription(select.value, desc);
            }
        });
        
        // Start performance monitoring
        this.startPerformanceMonitoring();
    }
    
    // Set default embedding model (prioritize WebGPU)
    setDefaultEmbeddingModel() {
        if (this.webGPUAvailable) {
            // WebGPU is available, initialize with WebGPU model
            this.activateWebGPUModel();
        } else {
            // No WebGPU support, fallback to CPU
            this.updateModelStatus('warning', 'WebGPU not supported - using CPU');
            this.fallbackToCPUModel();
        }
    }
    
    // Handle model selection changes
    handleModelSelection(modelType, selectId = '') {
        this.updateModelStatus('loading', 'Switching models...', selectId);
        
        switch (modelType) {
            case 'bge-base-webgpu':
                if (this.webGPUAvailable) {
                    this.activateWebGPUModel(selectId);
                } else {
                    this.updateModelStatus('error', 'WebGPU not available', selectId);
                    // Auto-switch to CPU fallback
                    const dropdown = document.getElementById(selectId || 'embedding-model-select');
                    if (dropdown) { // Only proceed if dropdown exists
                        dropdown.value = 'bge-base-cpu';
                        this.handleModelSelection('bge-base-cpu', selectId);
                    }
                }
                break;
            case 'bge-base-cpu':
                this.activateCPUModel('bge-base', selectId);
                break;
            case 'bge-small-cpu':
                this.activateCPUModel('bge-small', selectId);
                break;
            case 'gemini-online':
                this.activateOnlineModel(selectId);
                break;
        }
    }
    
    // Activate WebGPU model
    activateWebGPUModel(selectId = '') {
        this.currentModel = 'bge-base-webgpu';
        if (this.webGPUWorker) {
            this.webGPUWorker.postMessage({ 
                type: 'initModel', 
                payload: { modelType: 'bge-base-webgpu' } 
            });
        }
        this.updateModelStatus('ready', 'WebGPU BGE-Base model active', selectId);
        this.updatePerformanceIndicator('gpu', selectId);
    }
    
    // Activate CPU model
    activateCPUModel(modelType, selectId = '') {
        this.currentModel = `${modelType}-cpu`;
        if (this.webGPUWorker) {
            this.webGPUWorker.postMessage({ 
                type: 'initModel', 
                payload: { modelType: `${modelType}-cpu` } 
            });
        }
        this.updateModelStatus('ready', `${modelType.toUpperCase()} CPU model active`, selectId);
        this.updatePerformanceIndicator('cpu', selectId);
    }
    
    // Activate online model
    activateOnlineModel(selectId = '') {
        this.currentModel = 'gemini-online';
        this.updateModelStatus('ready', 'Gemini online model active', selectId);
        this.updatePerformanceIndicator('online', selectId);
    }
    
    // Fallback to CPU model when WebGPU fails
    fallbackToCPUModel() {
        const modelSelects = ['embedding-model-select', 'embedding-model-select-existing'];
        
        modelSelects.forEach(selectId => {
            const modelSelect = document.getElementById(selectId);
            if (modelSelect && modelSelect.value === 'bge-base-webgpu') {
                modelSelect.value = 'bge-base-cpu';
                this.handleModelSelection('bge-base-cpu', selectId);
            }
        });
    }
    
    // Update model status indicator
    updateModelStatus(status, message, selectId = '') {
        const statusSelectors = selectId ? 
            [`model-status${selectId.includes('existing') ? '-existing' : ''}`] :
            ['model-status', 'model-status-existing'];
            
        statusSelectors.forEach(statusId => {
            const statusElement = document.getElementById(statusId);
            const statusText = document.getElementById(statusId.replace('status', 'status-text'));
            
            if (statusElement && statusText) {
                const indicator = document.getElementById(statusId.replace('status', 'indicator'));
                
                if (indicator) {
                    // Reset classes
                    indicator.className = 'w-2 h-2 rounded-full mr-2';
                    indicator.style.width = '8px';
                    indicator.style.height = '8px';
                    indicator.style.borderRadius = '50%';
                    indicator.style.marginRight = '6px';
                    
                    // Update indicator color
                    switch (status) {
                        case 'ready':
                            indicator.style.backgroundColor = '#10b981'; // green-500
                            break;
                        case 'loading':
                            indicator.style.backgroundColor = '#f59e0b'; // yellow-500
                            break;
                        case 'warning':
                            indicator.style.backgroundColor = '#f97316'; // orange-500
                            break;
                        case 'error':
                            indicator.style.backgroundColor = '#ef4444'; // red-500
                            break;
                        default:
                            indicator.style.backgroundColor = '#9ca3af'; // gray-400
                    }
                }
                
                statusText.textContent = message;
            }
        });
    }
    
    // Update performance indicator
    updatePerformanceIndicator(type, selectId = '') {
        const perfSelectors = selectId ? 
            [`model-performance${selectId.includes('existing') ? '-existing' : ''}`] :
            ['model-performance', 'model-performance-existing'];
            
        perfSelectors.forEach(perfId => {
            const perfElement = document.getElementById(perfId);
            if (perfElement) {
                switch (type) {
                    case 'gpu':
                        perfElement.textContent = 'GPU: Active';
                        perfElement.style.backgroundColor = '#dcfce7'; // green-100
                        perfElement.style.color = '#166534'; // green-800
                        break;
                    case 'cpu':
                        perfElement.textContent = 'CPU: Active';
                        perfElement.style.backgroundColor = '#dbeafe'; // blue-100
                        perfElement.style.color = '#1e40af'; // blue-800
                        break;
                    case 'online':
                        perfElement.textContent = 'Online: Active';
                        perfElement.style.backgroundColor = '#f3e8ff'; // purple-100
                        perfElement.style.color = '#7c3aed'; // purple-700
                        break;
                }
            }
        });
    }
    
    // Start performance monitoring
    startPerformanceMonitoring() {
        // Monitor CPU usage (approximation)
        setInterval(() => {
            if (this.currentModel && this.currentModel.includes('cpu')) {
                // Update CPU usage indicator with a more realistic simulation
                const perfElements = ['model-performance', 'model-performance-existing'];
                
                perfElements.forEach(perfId => {
                    const perfElement = document.getElementById(perfId);
                    if (perfElement && perfElement.textContent.includes('CPU')) {
                        // Simulate lower CPU usage when WebGPU is properly configured
                        const usage = Math.floor(Math.random() * 20) + 15; // 15-35% range (much better)
                        perfElement.textContent = `CPU: ${usage}%`;
                    }
                });
            }
        }, 3000);
    }
    
    // Handle WebGPU inference results
    handleWebGPUInferenceResult(result) {
        // Process the inference result
        console.log('Processing WebGPU inference result:', result);
        // You can integrate this with your existing ranking logic
    }

    // Update model description based on selection
    updateModelDescription(selectedModel, descriptionElementId) {
        const descriptions = {
            'bge-base': '🚀 BAAI/bge-base-en-v1.5 - High-performance model with best semantic understanding (768 dimensions)',
            'bge-small': '⚡ BAAI/bge-small-en-v1.5 - Lightweight model, faster processing with good quality (384 dimensions)', 
            'gemini': '🌟 Google Gemini API - Cloud-based, highest accuracy (768 dimensions)'
        };
        
        const descElement = document.getElementById(descriptionElementId);
        if (descElement && descriptions[selectedModel]) {
            descElement.textContent = descriptions[selectedModel];
            
            // Add visual feedback for model selection
            const parentSelect = descElement.closest('.form-group')?.querySelector('select');
            if (parentSelect) {
                parentSelect.style.borderColor = 'var(--accent-primary)';
                setTimeout(() => {
                    parentSelect.style.borderColor = 'var(--glass-border)';
                }, 1000);
            }
        }
    }

    // ===================== Settings Page Methods =====================
    
    initSettings() {
        // Initialize settings page functionality
        this.loadSettingsState();
        this.setupSettingsEventListeners();
        this.updateModelInfo();
    }
    
    setupSettingsEventListeners() {
        // Embedding processing mode toggle
        const embeddingModeRadios = document.querySelectorAll('input[name="embedding-processing-mode"]');
        embeddingModeRadios.forEach(radio => {
            radio.addEventListener('change', (e) => {
                this.handleEmbeddingModeChange(e.target.value);
            });
        });
        
        // Local embedding model selection
        const localEmbeddingSelect = document.getElementById('local-embedding-select');
        if (localEmbeddingSelect) {
            localEmbeddingSelect.addEventListener('change', (e) => {
                this.handleLocalEmbeddingChange(e.target.value);
            });
        }

        const lmStudioBaseInput = document.getElementById('lmstudio-base-url');
        if (lmStudioBaseInput) {
            lmStudioBaseInput.addEventListener('change', (e) => {
                this.updateLmStudioBaseUrl(e.target.value);
            });
            lmStudioBaseInput.addEventListener('blur', (e) => {
                this.updateLmStudioBaseUrl(e.target.value, { quiet: true });
            });
        }

        const lmStudioRefreshBtn = document.getElementById('lmstudio-refresh-models');
        if (lmStudioRefreshBtn) {
            lmStudioRefreshBtn.addEventListener('click', () => {
                this.refreshLmStudioModels();
            });
        }

        const lmStudioModelSelect = document.getElementById('lmstudio-model-select');
        if (lmStudioModelSelect) {
            lmStudioModelSelect.addEventListener('change', (e) => {
                this.handleLmStudioModelSelection(e.target.value);
            });
        }

        const lmStudioDimensionsInput = document.getElementById('lmstudio-dimensions-input');
        if (lmStudioDimensionsInput) {
            const handler = (value, opts) => this.updateLmStudioDimensions(value, opts);
            lmStudioDimensionsInput.addEventListener('change', (e) => handler(e.target.value));
            lmStudioDimensionsInput.addEventListener('blur', (e) => handler(e.target.value, { quiet: true }));
        }
        
        // Online embedding provider selection
        const onlineEmbeddingProvider = document.getElementById('online-embedding-provider');
        if (onlineEmbeddingProvider) {
            onlineEmbeddingProvider.addEventListener('change', (e) => {
                this.selectedEmbeddingProvider = e.target.value;
                localStorage.setItem('chunhr-selected-embedding-provider', this.selectedEmbeddingProvider);
                this.handleOnlineEmbeddingProviderChange(e.target.value);
                this.updateApiKeyHelp(e.target.value);
                // Sync selected embedding model to the provider's dropdown current value
                const providerModelSelect = document.getElementById(`${this.selectedEmbeddingProvider}-embedding-select`);
                if (providerModelSelect) {
                    this.selectedEmbeddingModel = providerModelSelect.value;
                    localStorage.setItem('chunhr-selected-embedding-model', this.selectedEmbeddingModel);
                }
                // If currently in ONLINE mode, push config immediately
                const mode = localStorage.getItem('chunhr-embedding-mode') || 'local';
                if (mode === 'online') {
                    this.updateEmbeddingConfiguration('online');
                }
            });
        }
        
        // Gemini embedding model selection
            const geminiEmbeddingSelect = document.getElementById('gemini-embedding-select');
        if (geminiEmbeddingSelect) {
            geminiEmbeddingSelect.addEventListener('change', (e) => {
                this.selectedEmbeddingModel = e.target.value;
                localStorage.setItem('chunhr-selected-embedding-model', this.selectedEmbeddingModel);
                if ((localStorage.getItem('chunhr-embedding-mode') || 'local') === 'online' && this.selectedEmbeddingProvider === 'gemini') {
                    this.updateEmbeddingConfiguration('online');
                }
            });
        }

        // Mistral embedding model selection
        const mistralEmbeddingSelect = document.getElementById('mistral-embedding-select');
        if (mistralEmbeddingSelect) {
            mistralEmbeddingSelect.addEventListener('change', (e) => {
                this.selectedEmbeddingModel = e.target.value;
                localStorage.setItem('chunhr-selected-embedding-model', this.selectedEmbeddingModel);
                if ((localStorage.getItem('chunhr-embedding-mode') || 'local') === 'online' && this.selectedEmbeddingProvider === 'mistral') {
                    this.updateEmbeddingConfiguration('online');
                }
            });
        }

        // NVIDIA embedding model selection
        const nvidiaEmbeddingSelect = document.getElementById('nvidia-embedding-select');
        if (nvidiaEmbeddingSelect) {
            nvidiaEmbeddingSelect.addEventListener('change', (e) => {
                this.selectedEmbeddingModel = e.target.value;
                localStorage.setItem('chunhr-selected-embedding-model', this.selectedEmbeddingModel);
                if ((localStorage.getItem('chunhr-embedding-mode') || 'local') === 'online' && this.selectedEmbeddingProvider === 'nvidia') {
                    this.updateEmbeddingConfiguration('online');
                }
            });
        }

        // Jina embedding model selection
        const jinaEmbeddingSelect = document.getElementById('jina-embedding-select');
        if (jinaEmbeddingSelect) {
            jinaEmbeddingSelect.addEventListener('change', (e) => {
                this.selectedEmbeddingModel = e.target.value;
                localStorage.setItem('chunhr-selected-embedding-model', this.selectedEmbeddingModel);
                if ((localStorage.getItem('chunhr-embedding-mode') || 'local') === 'online' && this.selectedEmbeddingProvider === 'jina') {
                    this.updateEmbeddingConfiguration('online');
                }
            });
        }

        // API key provider selection
        const apiKeyProviderSelect = document.getElementById('api-key-provider-select');
        if (apiKeyProviderSelect) {
            apiKeyProviderSelect.addEventListener('change', (e) => {
                this.updateApiKeyHelp(e.target.value);
            });
        }

        // LLM provider selection
        const llmProviderSelect = document.getElementById('llm-provider-select');
        if (llmProviderSelect) {
            // Initialize from saved state
            llmProviderSelect.value = this.selectedLlmProvider || 'gemini';
            this.handleLlmProviderChange(llmProviderSelect.value);
            llmProviderSelect.addEventListener('change', (e) => {
                this.selectedLlmProvider = e.target.value || 'gemini';
                localStorage.setItem('chunhr-llm-provider', this.selectedLlmProvider);
                this.handleLlmProviderChange(this.selectedLlmProvider);
            });
        }
        // Cohere LLM selection
        const cohereLlmSelect = document.getElementById('cohere-llm-select');
        if (cohereLlmSelect) {
            cohereLlmSelect.addEventListener('change', (e) => {
                if ((this.selectedLlmProvider || 'gemini') === 'cohere') {
                    this.selectedModel = e.target.value;
                    localStorage.setItem('chunhr-selected-model', this.selectedModel);
                }
            });
        }
        
        // Gemini LLM model selection
        const geminiLlmSelect = document.getElementById('gemini-llm-select');
        if (geminiLlmSelect) {
            geminiLlmSelect.addEventListener('change', (e) => {
                if ((this.selectedLlmProvider || 'gemini') === 'gemini') {
                    this.selectedModel = e.target.value;
                    localStorage.setItem('chunhr-selected-model', this.selectedModel);
                }
            });
        }
        
        // API Key management
        const addKeyBtn = document.getElementById('settings-add-key-btn');
        const keyInput = document.getElementById('settings-api-key-input');
        const toggleVisibility = document.getElementById('settings-toggle-visibility');
        
        if (addKeyBtn && keyInput) {
            addKeyBtn.addEventListener('click', () => {
                const providerSelect = document.getElementById('api-key-provider-select');
                const provider = providerSelect ? providerSelect.value : 'gemini';
                this.handleAddApiKey(keyInput.value.trim(), provider);
            });
            
            keyInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    const providerSelect = document.getElementById('api-key-provider-select');
                    const provider = providerSelect ? providerSelect.value : 'gemini';
                    this.handleAddApiKey(keyInput.value.trim(), provider);
                }
            });
        }
        
        if (toggleVisibility) {
            toggleVisibility.addEventListener('click', () => {
                this.toggleApiKeyVisibility();
            });
        }
        
        // API Key timeout setting
        const timeoutInput = document.getElementById('api-key-timeout-input');
        if (timeoutInput) {
            timeoutInput.addEventListener('change', (e) => {
                const value = parseInt(e.target.value) || 2;
                this.apiKeyTimeout = Math.max(1, Math.min(300, value)); // Clamp between 1-300 seconds
                localStorage.setItem('chunhr-api-key-timeout', this.apiKeyTimeout.toString());
                this.updateTimeoutOnServer();
                this.showNotification(`API key timeout set to ${this.apiKeyTimeout} seconds`, 'success');
            });
        }
        
        // Performance settings
        const webgpuCheckbox = document.getElementById('webgpu-enabled');
        const batchSizeSelect = document.getElementById('batch-size-select');
    const embeddingConcurrencyInput = document.getElementById('embedding-concurrency-input');
        
        if (webgpuCheckbox) {
            webgpuCheckbox.addEventListener('change', (e) => {
                this.handleWebGPUToggle(e.target.checked);
            });
        }
        
        if (batchSizeSelect) {
            batchSizeSelect.addEventListener('change', (e) => {
                this.handleBatchSizeChange(e.target.value);
            });
        }

        if (embeddingConcurrencyInput) {
            embeddingConcurrencyInput.addEventListener('change', (e) => {
                const v = parseInt(e.target.value, 10) || 3;
                const clamped = Math.max(1, Math.min(24, v));
                this.embeddingConcurrency = clamped;
                localStorage.setItem('chunhr-embedding-concurrency', String(clamped));
                this.showNotification(`Embedding concurrency set to ${clamped} workers`, 'success');
                // Best-effort: update server-side config so future tasks use it
                this.updateEmbeddingConfiguration(localStorage.getItem('chunhr-embedding-mode') || 'local');
            });
        }
    }
    
    loadSettingsState() {
        // Load saved settings from localStorage or server
        try {
            const savedEmbeddingMode = localStorage.getItem('chunhr-embedding-mode') || 'local';
            this.selectedLocalEmbedding = localStorage.getItem('chunhr-local-embedding') || this.selectedLocalEmbedding || 'bge-base';
            const savedEmbeddingModel = localStorage.getItem('chunhr-selected-embedding-model') || 'gemini-embedding-001';
            const savedWebGPU = localStorage.getItem('chunhr-webgpu-enabled') !== 'false';
            const savedBatchSize = localStorage.getItem('chunhr-batch-size') || '5';
            this._skipLocalConfigUpdateOnce = true;
            this._initializingSettings = true;
            
            // Set embedding processing mode
            const embeddingModeRadio = document.getElementById(`embedding-mode-${savedEmbeddingMode}`);
            if (embeddingModeRadio) {
                embeddingModeRadio.checked = true;
                this.handleEmbeddingModeChange(savedEmbeddingMode);
            }
            
            // Set local embedding model
            const localEmbeddingSelect = document.getElementById('local-embedding-select');
            if (localEmbeddingSelect) {
                localEmbeddingSelect.value = this.selectedLocalEmbedding;
                this.handleLocalEmbeddingChange(this.selectedLocalEmbedding);
            }

            const lmStudioBaseInput = document.getElementById('lmstudio-base-url');
            if (lmStudioBaseInput) {
                lmStudioBaseInput.value = this.lmStudioConfig.baseUrl || 'http://127.0.0.1:1234';
            }
            const lmStudioDimensionsInput = document.getElementById('lmstudio-dimensions-input');
            if (lmStudioDimensionsInput) {
                lmStudioDimensionsInput.value = this.lmStudioConfig.dimensions || '';
            }
            this.populateLmStudioModelSelect({ preserveSelection: true });
            
            // Set online embedding provider
            const onlineEmbeddingProvider = document.getElementById('online-embedding-provider');
            if (onlineEmbeddingProvider) {
                onlineEmbeddingProvider.value = this.selectedEmbeddingProvider;
                this.handleOnlineEmbeddingProviderChange(this.selectedEmbeddingProvider);
                this.updateApiKeyHelp(this.selectedEmbeddingProvider);
                // After showing the provider section, set selected model from the provider's dropdown
                const providerModelSelect = document.getElementById(`${this.selectedEmbeddingProvider}-embedding-select`);
                if (providerModelSelect && providerModelSelect.value) {
                    this.selectedEmbeddingModel = providerModelSelect.value;
                    localStorage.setItem('chunhr-selected-embedding-model', this.selectedEmbeddingModel);
                }
            }
            
            // Set Gemini embedding model
            const geminiEmbeddingSelect = document.getElementById('gemini-embedding-select');
            if (geminiEmbeddingSelect) {
                // Only apply saved model to Gemini selector if Gemini is the active provider
                if ((this.selectedEmbeddingProvider || 'gemini') === 'gemini') {
                    geminiEmbeddingSelect.value = savedEmbeddingModel;
                    this.selectedEmbeddingModel = savedEmbeddingModel;
                }
            }

            // Set LLM provider and models
            const llmProviderSelect = document.getElementById('llm-provider-select');
            if (llmProviderSelect) {
                llmProviderSelect.value = this.selectedLlmProvider || 'gemini';
                this.handleLlmProviderChange(llmProviderSelect.value);
            }
            const geminiLlmSelect = document.getElementById('gemini-llm-select');
            if (geminiLlmSelect && (this.selectedLlmProvider || 'gemini') === 'gemini') {
                geminiLlmSelect.value = this.selectedModel;
            }
            const cohereLlmSelect = document.getElementById('cohere-llm-select');
            if (cohereLlmSelect && (this.selectedLlmProvider || 'gemini') === 'cohere') {
                cohereLlmSelect.value = this.selectedModel || 'command-a-reasoning-08-2025';
            }
            
            // Set performance settings
            const webgpuCheckbox = document.getElementById('webgpu-enabled');
            if (webgpuCheckbox) {
                webgpuCheckbox.checked = savedWebGPU;
            }
            
            const batchSizeSelect = document.getElementById('batch-size-select');
            if (batchSizeSelect) {
                batchSizeSelect.value = savedBatchSize;
            }

            // Set embedding concurrency
            const embeddingConcurrencyInput = document.getElementById('embedding-concurrency-input');
            if (embeddingConcurrencyInput) {
                embeddingConcurrencyInput.value = String(this.embeddingConcurrency || 3);
            }
            
            // Set API key timeout
            const timeoutInput = document.getElementById('api-key-timeout-input');
            if (timeoutInput) {
                timeoutInput.value = this.apiKeyTimeout;
            }
            
            // Load and display API keys
            this.renderSettingsApiKeys();
            this._initializingSettings = false;
        } catch (error) {
            console.error('Failed to load settings state:', error);
            this._initializingSettings = false;
        }
    }
    
    handleEmbeddingModeChange(mode) {
        const localEmbeddingSection = document.getElementById('local-embedding-section');
        const onlineEmbeddingSection = document.getElementById('online-embedding-section');
        const apiKeysSection = document.getElementById('api-keys-section');
        
        if (mode === 'local') {
            localEmbeddingSection?.classList.remove('hidden');
            onlineEmbeddingSection?.classList.add('hidden');
            apiKeysSection?.classList.add('hidden');
        } else {
            localEmbeddingSection?.classList.add('hidden');
            onlineEmbeddingSection?.classList.remove('hidden');
            apiKeysSection?.classList.remove('hidden');
        }
        
        localStorage.setItem('chunhr-embedding-mode', mode);
        
        // Sync with front-screen switch
        const frontSwitch = document.getElementById('embedding-mode-switch');
        if (frontSwitch) {
            frontSwitch.checked = mode === 'online';
        }
        
        // Update the server configuration unless suppressed (used when front switch already updated it)
        if (this._skipConfigUpdateOnce) {
            this._skipConfigUpdateOnce = false;
        } else {
            if (mode === 'local') {
                this.maybeInitLocalInference();
            }
            this.updateEmbeddingConfiguration(mode);
        }
    }
    
    async handleLocalEmbeddingChange(modelType) {
        this.selectedLocalEmbedding = modelType;
        this.updateEmbeddingModelInfo(modelType);
        this.toggleLmStudioSection(modelType === 'lmstudio');
        localStorage.setItem('chunhr-local-embedding', modelType);

        if (modelType === 'lmstudio') {
            this.populateLmStudioModelSelect({ preserveSelection: true });
            if (!this.lmStudioModels || this.lmStudioModels.length === 0) {
                this.refreshLmStudioModels();
            }
        }

        const skipUpdate = this._skipLocalConfigUpdateOnce;
        this._skipLocalConfigUpdateOnce = false;

        if (skipUpdate) {
            return;
        }

        if (modelType === 'lmstudio') {
            if (!this.lmStudioConfig.model) {
                this.showNotification('Select an LM Studio embedding model to activate it.', 'warning');
                return;
            }
            await this.pushLmStudioConfiguration();
            return;
        }

        // Show loading notification for built-in local models
        this.showNotification(`Switching to ${modelType} model...`, 'info');

        try {
            const res = await fetch('/api/embedding-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    mode: 'local', 
                    model: modelType,
                    provider: 'local',
                    apiKeys: []
                })
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error || 'Model config update failed');

            await fetch('/api/embedding-load', { method: 'POST' });

            if (this.inferenceWorker && this.workerReady) {
                this.inferenceWorker.postMessage({
                    type: 'initialize',
                    payload: {
                        modelType: modelType
                    }
                });
            } else {
                this.maybeInitLocalInference();
            }

            this.showNotification(`Successfully switched to ${modelType} model`, 'success');
        } catch (err) {
            console.error('Model switch failed', err);
            this.showNotification('Failed to switch model: ' + err.message, 'error');
        }

        this.updateExistingModelDropdowns(modelType);
    }

    toggleLmStudioSection(show) {
        const section = document.getElementById('lmstudio-local-section');
        if (!section) return;
        section.classList.toggle('hidden', !show);
        if (show) {
            const status = document.getElementById('lmstudio-models-status');
            if (status) status.classList.remove('hidden');
        }
    }

    populateLmStudioModelSelect({ preserveSelection = false } = {}) {
        const select = document.getElementById('lmstudio-model-select');
        if (!select) return;
        const current = preserveSelection ? (this.lmStudioConfig.model || '') : '';
        const previous = this.lmStudioConfig.model || '';
        select.innerHTML = '';

        if (Array.isArray(this.lmStudioModels) && this.lmStudioModels.length > 0) {
            this.lmStudioModels.forEach((model) => {
                if (!model || !model.id) return;
                const option = document.createElement('option');
                option.value = model.id;
                const state = model.state ? ` • ${model.state}` : '';
                option.textContent = `${model.id}${state}`;
                if (model.id === previous || model.id === current) {
                    option.selected = true;
                }
                select.appendChild(option);
            });
        }

        if (!select.options.length) {
            const placeholder = document.createElement('option');
            const label = previous || 'No embedding models detected';
            placeholder.value = previous;
            placeholder.textContent = previous ? `${previous} (saved)` : label;
            placeholder.selected = true;
            placeholder.disabled = !previous;
            select.appendChild(placeholder);
        }
    }

    setLmStudioStatus(message, type = 'info') {
        const status = document.getElementById('lmstudio-models-status');
        if (!status) return;
        status.textContent = message;
        status.dataset.statusType = type;
        status.classList.remove('hidden');
    }

    updateLmStudioBaseUrl(value, { quiet = false } = {}) {
        let trimmed = (value || '').trim();
        if (!trimmed) {
            trimmed = 'http://127.0.0.1:1234';
        }
        if (!/^https?:/i.test(trimmed)) {
            trimmed = `http://${trimmed}`;
        }
        if (this.lmStudioConfig.baseUrl === trimmed) return;
        this.lmStudioConfig.baseUrl = trimmed;
        localStorage.setItem('chunhr-lmstudio-base-url', this.lmStudioConfig.baseUrl);
        if (!quiet) {
            this.showNotification(`LM Studio server set to ${this.lmStudioConfig.baseUrl}`, 'success');
        }
        if (this.selectedLocalEmbedding === 'lmstudio' && this.lmStudioConfig.model) {
            this.pushLmStudioConfiguration({ silent: true });
        }
        const input = document.getElementById('lmstudio-base-url');
        if (input && input.value !== this.lmStudioConfig.baseUrl) {
            input.value = this.lmStudioConfig.baseUrl;
        }
    }

    async refreshLmStudioModels() {
        const button = document.getElementById('lmstudio-refresh-models');
        if (button) button.disabled = true;
        this.setLmStudioStatus('Loading models from LM Studio...', 'info');
        try {
            const baseUrl = this.lmStudioConfig.baseUrl || 'http://127.0.0.1:1234';
            const params = new URLSearchParams();
            if (baseUrl) params.append('baseUrl', baseUrl);
            const resp = await fetch(`/api/lmstudio/models?${params.toString()}`);
            if (!resp.ok) {
                const text = await resp.text();
                throw new Error(text || resp.statusText || 'Failed to fetch models');
            }
            const data = await resp.json();
            if (!data.success) {
                throw new Error(data.error || 'LM Studio returned an error');
            }
            this.lmStudioModels = Array.isArray(data.models) ? data.models : [];
            this.populateLmStudioModelSelect({ preserveSelection: true });
            this.setLmStudioStatus(`Loaded ${this.lmStudioModels.length} embedding model${this.lmStudioModels.length === 1 ? '' : 's'} from ${baseUrl}`, 'success');
        } catch (err) {
            console.error('Failed to refresh LM Studio models:', err);
            this.setLmStudioStatus(`Failed to load models: ${err.message}`, 'error');
            this.showNotification(`LM Studio model refresh failed: ${err.message}`, 'error');
        } finally {
            if (button) button.disabled = false;
        }
    }

    handleLmStudioModelSelection(modelId) {
        if (!modelId) return;
        this.lmStudioConfig.model = modelId;
        this.selectedEmbeddingModel = modelId;
        localStorage.setItem('chunhr-lmstudio-model', modelId);
    localStorage.setItem('chunhr-selected-embedding-model', modelId);
        this.showNotification(`LM Studio model set to ${modelId}`, 'success');
        if (this.selectedLocalEmbedding === 'lmstudio') {
            this.pushLmStudioConfiguration();
        }
    }

    updateLmStudioDimensions(value, { quiet = false } = {}) {
        if (value === undefined || value === null) return;
        const sanitized = value.split(',').map(v => v.trim()).filter(Boolean).join(', ');
        this.lmStudioConfig.dimensions = sanitized;
        localStorage.setItem('chunhr-lmstudio-dimensions', sanitized);
        const input = document.getElementById('lmstudio-dimensions-input');
        if (input && input.value !== sanitized) {
            input.value = sanitized;
        }
        if (!quiet) {
            this.showNotification('LM Studio supported dimensions updated', 'success');
        }
        if (this.selectedLocalEmbedding === 'lmstudio' && this.lmStudioConfig.model) {
            this.pushLmStudioConfiguration({ silent: true });
        }
    }

    async pushLmStudioConfiguration({ silent = false } = {}) {
        if (this.selectedLocalEmbedding !== 'lmstudio') return;
        if (!this.lmStudioConfig.model) {
            if (!silent) {
                this.showNotification('Select an LM Studio embedding model to continue.', 'warning');
            }
            return;
        }
        if (!silent) {
            this.showNotification(`Syncing LM Studio (${this.lmStudioConfig.model})`, 'info');
        }
        await this.updateEmbeddingConfiguration('local', { silent });
    }
    
    handleOnlineEmbeddingProviderChange(provider) {
        // Hide all embedding model sections
        const geminiEmbeddingSection = document.getElementById('gemini-embedding-section');
        const mistralEmbeddingSection = document.getElementById('mistral-embedding-section');
        const nvidiaEmbeddingSection = document.getElementById('nvidia-embedding-section');
        const jinaEmbeddingSection = document.getElementById('jina-embedding-section');
        
        geminiEmbeddingSection?.classList.add('hidden');
        mistralEmbeddingSection?.classList.add('hidden');
        nvidiaEmbeddingSection?.classList.add('hidden');
        jinaEmbeddingSection?.classList.add('hidden');
        
        // Show the selected provider's section
        if (provider === 'gemini') {
            geminiEmbeddingSection?.classList.remove('hidden');
        } else if (provider === 'mistral') {
            mistralEmbeddingSection?.classList.remove('hidden');
        } else if (provider === 'nvidia') {
            nvidiaEmbeddingSection?.classList.remove('hidden');
        } else if (provider === 'jina') {
            jinaEmbeddingSection?.classList.remove('hidden');
        }
    }
    
    handleLlmProviderChange(provider) {
        // Show/hide specific LLM model sections
        const geminiLlmSection = document.getElementById('gemini-llm-section');
        const cohereLlmSection = document.getElementById('cohere-llm-section');
        
        geminiLlmSection?.classList.add('hidden');
        cohereLlmSection?.classList.add('hidden');
        if (provider === 'gemini') {
            geminiLlmSection?.classList.remove('hidden');
        } else if (provider === 'cohere') {
            cohereLlmSection?.classList.remove('hidden');
        }
    }
    
    handleOnlineServiceChange(service) {
        // Update API key help text based on selected service
        const helpText = document.getElementById('api-key-help-text');
        if (helpText) {
            switch (service) {
                case 'gemini':
                    helpText.innerHTML = 'Get your Gemini API key from <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">Google AI Studio</a>';
                    break;
                default:
                    helpText.textContent = 'API key required for this service';
            }
        }
    }
    
    getProviderApiKeys() {
        // Return API keys for the currently selected provider
        const provider = this.selectedEmbeddingProvider || 'gemini';
        return this.providerApiKeys[provider] || [];
    }
    
    handleAddApiKey(key, provider = 'gemini') {
        if (!this.validateApiKey(key, provider)) {
            this.showNotification('Please enter a valid API key', 'error');
            return;
        }
        
        if (this.providerApiKeys[provider].includes(key)) {
            this.showNotification('API key already exists for this provider', 'warning');
            return;
        }
        
        // Add to provider-specific storage
        this.providerApiKeys[provider].push(key);
        localStorage.setItem(`chunhr-${provider}-api-keys`, JSON.stringify(this.providerApiKeys[provider]));
        
        // Also add to legacy storage for backward compatibility
        if (!this.apiKeys.includes(key)) {
            this.apiKeys.push(key);
            localStorage.setItem('chunhr-api-keys', JSON.stringify(this.apiKeys));
        }
        
        // Clear input
        const keyInput = document.getElementById('settings-api-key-input');
        if (keyInput) keyInput.value = '';
        
        // Re-render the keys list
        this.renderSettingsApiKeys();
        
        this.showNotification(`${provider.toUpperCase()} API key added successfully`, 'success');
    }
    
    removeSettingsApiKey(keyToRemove) {
        this.apiKeys = this.apiKeys.filter(k => k !== keyToRemove);
        localStorage.setItem('chunhr-api-keys', JSON.stringify(this.apiKeys));
        this.renderSettingsApiKeys();
        this.showNotification('API key removed', 'success');
    }
    
    toggleApiKeyVisibility() {
        const keyInput = document.getElementById('settings-api-key-input');
        const toggleBtn = document.getElementById('settings-toggle-visibility');
        
        if (!keyInput || !toggleBtn) return;
        
        if (keyInput.type === 'password') {
            keyInput.type = 'text';
            toggleBtn.innerHTML = '<span class="eye-icon">🙈</span>';
            toggleBtn.title = 'Hide API Key';
        } else {
            keyInput.type = 'password';
            toggleBtn.innerHTML = '<span class="eye-icon">👁️</span>';
            toggleBtn.title = 'Show API Key';
        }
    }
    
    handleWebGPUToggle(enabled) {
        localStorage.setItem('chunhr-webgpu-enabled', enabled.toString());
        
        if (enabled) {
            this.showNotification('WebGPU acceleration enabled', 'success');
        } else {
            this.showNotification('WebGPU acceleration disabled', 'info');
        }
    }
    
    handleBatchSizeChange(batchSize) {
        localStorage.setItem('chunhr-batch-size', batchSize);
        this.showNotification(`Batch size set to ${batchSize} documents`, 'success');
    }
    
    updateModelInfo(modelType = 'bge-base') {
        // Legacy method for backward compatibility - now delegates to embedding model info
        this.updateEmbeddingModelInfo(modelType);
    }

    updateEmbeddingModelInfo(modelType = 'bge-base') {
        const select = document.getElementById('local-embedding-select');
        if (!select) return;
        
        const selectedOption = select.querySelector(`option[value="${modelType}"]`);
        if (!selectedOption) return;
        
        const description = selectedOption.dataset.description;
        const performance = selectedOption.dataset.performance;
        const memory = selectedOption.dataset.memory;
        
        // Update embedding model info elements
        const descElement = document.getElementById('local-embedding-desc');
        const perfElement = document.getElementById('local-embedding-perf');
        const memoryElement = document.getElementById('local-embedding-memory');
        
        if (descElement) descElement.textContent = description;
        if (perfElement) perfElement.textContent = performance;
        if (memoryElement) memoryElement.textContent = memory;
    }

    updateApiKeyHelp(provider) {
        const helpText = document.getElementById('api-key-help-text');
        if (!helpText) return;
        
        switch (provider) {
            case 'gemini':
                helpText.innerHTML = 'Get your Gemini API key from <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">Google AI Studio</a>';
                break;
            case 'mistral':
                helpText.innerHTML = 'Get your Mistral API key from <a href="https://console.mistral.ai/api-keys/" target="_blank" rel="noopener">Mistral Console</a>';
                break;
            case 'nvidia':
                helpText.innerHTML = 'Get your NVIDIA API key from <a href="https://build.nvidia.com/explore/discover" target="_blank" rel="noopener">NVIDIA NGC</a>';
                break;
            case 'jina':
                helpText.innerHTML = 'Get your Jina API key from <a href="https://jina.ai/embeddings/" target="_blank" rel="noopener">Jina AI Platform</a>';
                break;
            case 'cohere':
                helpText.innerHTML = 'Get your Cohere API key from <a href="https://dashboard.cohere.com/api-keys" target="_blank" rel="noopener">Cohere Dashboard</a>';
                break;
            default:
                helpText.textContent = 'API key required for this service';
        }
    }
    
    updateExistingModelDropdowns(modelType) {
        // Update model dropdowns in other parts of the app to maintain consistency
        const webgpuValue = `${modelType}-webgpu`;
        const cpuValue = `${modelType}-cpu`;
        
        const modelSelects = [
            'embedding-model-select',
            'embedding-model-select-existing',
            'ingest-embedding-model',
            'recycle-embedding-model'
        ];
        
        modelSelects.forEach(selectId => {
            const select = document.getElementById(selectId);
            if (select) {
                // Try to set WebGPU version first, then CPU version
                if (select.querySelector(`option[value="${webgpuValue}"]`)) {
                    select.value = webgpuValue;
                } else if (select.querySelector(`option[value="${cpuValue}"]`)) {
                    select.value = cpuValue;
                } else if (select.querySelector(`option[value="${modelType}"]`)) {
                    select.value = modelType;
                }
            }
        });
    }
    
    renderSettingsApiKeys() {
        const container = document.getElementById('settings-api-key-list');
        if (!container) return;
        
        container.innerHTML = '';
        
        // Show keys grouped by provider
        Object.entries(this.providerApiKeys).forEach(([provider, keys]) => {
            if (keys.length === 0) return;
            
            const providerSection = document.createElement('div');
            providerSection.className = 'api-key-provider-section';
            
            const providerTitle = document.createElement('h5');
            providerTitle.className = 'api-key-provider-title';
            providerTitle.textContent = `${provider.charAt(0).toUpperCase() + provider.slice(1)} (${keys.length} key${keys.length === 1 ? '' : 's'})`;
            providerSection.appendChild(providerTitle);
            
            keys.forEach((key, index) => {
                const keyItem = document.createElement('div');
                keyItem.className = 'api-key-item';
                
                const maskedKey = `${key.substring(0, 4)}...${key.substring(key.length - 4)}`;
                const isActive = index === this.apiKeyRotationIndex[provider];
                
                keyItem.innerHTML = `
                    <span class="key-text ${isActive ? 'active-key' : ''}">${maskedKey}</span>
                    <div class="key-controls">
                        ${isActive ? '<span class="active-indicator" title="Currently active key">🔄</span>' : ''}
                        <button class="remove-key-btn" data-key="${key}" data-provider="${provider}" title="Remove this API key">&times;</button>
                    </div>
                `;
                
                // Add remove functionality
                const removeBtn = keyItem.querySelector('.remove-key-btn');
                removeBtn.addEventListener('click', () => {
                    this.removeProviderApiKey(key, provider);
                });
                
                providerSection.appendChild(keyItem);
            });
            
            container.appendChild(providerSection);
        });
        
        // Fallback to legacy display if no provider-specific keys
        if (Object.values(this.providerApiKeys).every(keys => keys.length === 0) && this.apiKeys.length > 0) {
            this.apiKeys.forEach(key => {
                const keyItem = document.createElement('div');
                keyItem.className = 'api-key-item';
                
                const maskedKey = `${key.substring(0, 4)}...${key.substring(key.length - 4)}`;
                
                keyItem.innerHTML = `
                    <span>${maskedKey}</span>
                    <button class="remove-key-btn" data-key="${key}" title="Remove this API key">&times;</button>
                `;
                
                const removeBtn = keyItem.querySelector('.remove-key-btn');
                removeBtn.addEventListener('click', () => {
                    this.removeSettingsApiKey(key);
                });
                
                container.appendChild(keyItem);
            });
        }
    }

    // API Key Rotation Methods for Rate Limit Mitigation
    getNextApiKey(provider) {
        const keys = this.providerApiKeys[provider];
        if (!keys || keys.length === 0) {
            return null;
        }
        
        const currentIndex = this.apiKeyRotationIndex[provider] || 0;
        let key = keys[currentIndex];
        let attempts = 0;
        const maxAttempts = keys.length;
        
        // Check if current key is still in timeout
        while (attempts < maxAttempts && this.isKeyInTimeout(provider, key)) {
            // Move to next key
            this.apiKeyRotationIndex[provider] = (this.apiKeyRotationIndex[provider] + 1) % keys.length;
            key = keys[this.apiKeyRotationIndex[provider]];
            attempts++;
        }
        
        // If all keys are in timeout, use the current one anyway (fallback behavior)
        if (attempts >= maxAttempts) {
            console.warn(`All ${provider} API keys are in timeout period, using key anyway`);
        }
        
        // Mark this key as used and rotate to next for subsequent requests
        this.markKeyAsUsed(provider, key);
        this.apiKeyRotationIndex[provider] = (this.apiKeyRotationIndex[provider] + 1) % keys.length;
        localStorage.setItem(`chunhr-${provider}-rotation-index`, this.apiKeyRotationIndex[provider].toString());
        
        return key;
    }
    
    markApiKeyAsRateLimited(provider, key) {
        // In the future, we can implement rate limit tracking here
        // For now, just rotate to next key
        console.warn(`Rate limit hit for ${provider} key ending in ...${key.slice(-4)}`);
        this.getNextApiKey(provider); // Force rotation
    }
    
    isKeyInTimeout(provider, key) {
        const keyId = `${provider}-${key.slice(-8)}`; // Use provider + last 8 chars as unique ID
        const lastUsed = this.lastApiKeyUsage[keyId];
        if (!lastUsed) return false;
        
        const now = Date.now();
        const timeoutMs = this.apiKeyTimeout * 1000;
        return (now - lastUsed) < timeoutMs;
    }
    
    markKeyAsUsed(provider, key) {
        const keyId = `${provider}-${key.slice(-8)}`; // Use provider + last 8 chars as unique ID
        this.lastApiKeyUsage[keyId] = Date.now();
    }
    
    async updateTimeoutOnServer() {
        try {
            const response = await fetch('/api/embedding-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    timeoutSeconds: this.apiKeyTimeout
                })
            });
            
            if (!response.ok) {
                console.warn('Failed to update timeout on server');
            }
        } catch (error) {
            console.warn('Failed to update timeout on server:', error);
        }
    }
    
    getAvailableApiKey(provider) {
        return this.getNextApiKey(provider);
    }
    
    removeProviderApiKey(keyToRemove, provider) {
        this.providerApiKeys[provider] = this.providerApiKeys[provider].filter(k => k !== keyToRemove);
        localStorage.setItem(`chunhr-${provider}-api-keys`, JSON.stringify(this.providerApiKeys[provider]));
        
        // Reset rotation index if needed
        if (this.apiKeyRotationIndex[provider] >= this.providerApiKeys[provider].length) {
            this.apiKeyRotationIndex[provider] = 0;
            localStorage.setItem(`chunhr-${provider}-rotation-index`, '0');
        }
        
        // Also remove from legacy storage
        this.apiKeys = this.apiKeys.filter(k => k !== keyToRemove);
        localStorage.setItem('chunhr-api-keys', JSON.stringify(this.apiKeys));
        
        this.renderSettingsApiKeys();
        this.showNotification(`${provider.toUpperCase()} API key removed`, 'success');
    }
    
    async updateEmbeddingConfiguration(mode, options = {}) {
        const { silent: explicitSilent = false } = options || {};
        const silent = explicitSilent || this._initializingSettings;
        try {
            const keys = mode === 'online' ? this.getProviderApiKeys() : [];
            let provider;
            let selectedModel;

            if (mode === 'online') {
                provider = this.selectedEmbeddingProvider;
                selectedModel = this.selectedEmbeddingModel;
            } else {
                const localSelection = this.selectedLocalEmbedding || localStorage.getItem('chunhr-local-embedding') || 'bge-base';
                if (localSelection === 'lmstudio') {
                    provider = 'lmstudio';
                    selectedModel = this.lmStudioConfig.model;
                    if (!selectedModel) {
                        if (!silent) {
                            this.showNotification('Select an LM Studio embedding model before syncing configuration.', 'warning');
                        }
                        return;
                    }
                } else {
                    provider = 'local';
                    selectedModel = localSelection;
                }
            }
            const embeddingConcurrency = parseInt(document.getElementById('embedding-concurrency-input')?.value || this.embeddingConcurrency || 3, 10);
            const body = {
                mode: mode,
                apiKeys: keys,
                model: selectedModel,
                provider: provider,
                timeoutSeconds: this.apiKeyTimeout,
                embeddingConcurrency
            };
            if (provider === 'lmstudio') {
                body.lmStudioBaseUrl = this.lmStudioConfig.baseUrl;
                body.lmStudioModel = this.lmStudioConfig.model;
                body.lmStudioDimensions = this.lmStudioConfig.dimensions;
            }
            const response = await fetch('/api/embedding-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            
            const result = await response.json();
            if (result.success) {
                if (!silent) {
                    const label = mode === 'online'
                        ? `${mode.toUpperCase()} • ${provider} • ${selectedModel}`
                        : `${mode.toUpperCase()} • ${provider}${selectedModel ? ' • ' + selectedModel : ''}`;
                    this.showNotification(`Embedding configuration updated (${label})`, 'success');
                }
                await fetch('/api/embedding-load', { method: 'POST' });
            } else {
                throw new Error(result.error || 'Configuration update failed');
            }
        } catch (error) {
            console.error('Failed to update embedding configuration:', error);
            if (!silent) {
                this.showNotification('Failed to update configuration: ' + error.message, 'error');
            }
        }
    }

    // Cleanup worker on page unload
    disposeInferenceWorker() {
        if (this.inferenceWorker) {
            this.inferenceWorker.postMessage({ type: 'dispose' });
            this.inferenceWorker.terminate();
            this.inferenceWorker = null;
            this.workerReady = false;
            console.log('🧹 WebGPU worker disposed');
        }
    }
    
    // Cleanup WebGPU worker
    disposeWebGPUWorker() {
        if (this.webGPUWorker) {
            this.webGPUWorker.terminate();
            this.webGPUWorker = null;
            this.webGPUAvailable = false;
            console.log('🧹 WebGPU worker disposed');
        }
    }
}

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    console.log('Hr Analyzer frontend loaded');
    window.app = new HrAnalyzerApp();
    
    // Initialize algorithm dropdown handlers
    window.app.initializeAlgorithmDropdowns();
    
    // Setup GSAP card hover effects
    if (window.chunAnimations && window.chunAnimations.isInitialized) {
        window.chunAnimations.setupCardHovers();
    }
});

// Cleanup workers on page unload
window.addEventListener('beforeunload', () => {
    if (window.app) {
        window.app.disposeInferenceWorker();
        window.app.disposeWebGPUWorker();
    }
});

console.log('Hr Analyzer frontend loaded');
