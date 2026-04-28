// Gmail Workspace Frontend Module
// Handles Gmail OAuth, email fetching, and resume processing UI

(function() {
    'use strict';

    // Gmail Workspace state
    const gmailState = {
        credentials: JSON.parse(localStorage.getItem('chunhr-gmail-credentials') || 'null'),
        tokens: JSON.parse(localStorage.getItem('chunhr-gmail-tokens') || 'null'),
        isConnected: false,
        activeJobId: null
    };

    const ACTIVE_GMAIL_JOB_KEY = 'chunhr-gmail-active-job';
    let gmailJobPollTimer = null;

    // Initialize Gmail Workspace when app initializes
    function initGmailWorkspace() {
        console.log('Initializing Gmail Workspace module...');
        
        // Load saved credentials
        loadGmailCredentials();
        
        // Setup event listeners
        setupGmailEventListeners();
        
        // Setup socket listeners
        setupGmailSocketListeners();
        
        // Check connection status
        updateGmailConnectionUI();
        
        // Handle OAuth callback messages
        window.addEventListener('message', handleOAuthMessage);
        window.addEventListener('storage', handleStorageSync);
    }

    function loadGmailCredentials() {
        const clientId = localStorage.getItem('chunhr-gmail-client-id');
        const clientSecret = localStorage.getItem('chunhr-gmail-client-secret');
        if (clientId && clientSecret) {
            gmailState.credentials = { clientId, clientSecret };
            document.getElementById('gmail-client-id').value = clientId;
            document.getElementById('gmail-client-secret').value = clientSecret;
        }
        
        if (gmailState.tokens) {
            gmailState.isConnected = true;
        }
    }

    function setupGmailEventListeners() {
        // Settings - Save credentials
        const saveCredentialsBtn = document.getElementById('gmail-save-credentials-btn');
        if (saveCredentialsBtn) {
            saveCredentialsBtn.addEventListener('click', saveGmailCredentials);
        }

        // Settings - Toggle secret visibility
        const toggleSecretBtn = document.getElementById('gmail-toggle-secret-visibility');
        if (toggleSecretBtn) {
            toggleSecretBtn.addEventListener('click', () => {
                const input = document.getElementById('gmail-client-secret');
                input.type = input.type === 'password' ? 'text' : 'password';
            });
        }

        // Gmail Workspace view - Connect button
        const connectBtn = document.getElementById('gmail-connect-btn');
        if (connectBtn) {
            connectBtn.addEventListener('click', initiateGmailAuth);
        }

        // Gmail Workspace view - Disconnect button
        const disconnectBtn = document.getElementById('gmail-disconnect-btn');
        if (disconnectBtn) {
            disconnectBtn.addEventListener('click', disconnectGmail);
        }

        // Gmail Workspace view - Test connection
        const testConnBtn = document.getElementById('gmail-test-connection-btn');
        if (testConnBtn) {
            testConnBtn.addEventListener('click', testGmailConnection);
        }

        // Start fetching resumes
        const startFetchBtn = document.getElementById('gmail-start-fetch-btn');
        if (startFetchBtn) {
            startFetchBtn.addEventListener('click', startFetchingResumes);
        }

        // New fetch button (after results)
        const newFetchBtn = document.getElementById('gmail-new-fetch-btn');
        if (newFetchBtn) {
            newFetchBtn.addEventListener('click', () => {
                clearStoredActiveGmailJob();
                showGmailSection('intro');
            });
        }

        // Go to analyzer button
        const viewAnalyzerBtn = document.getElementById('gmail-view-analyzer-btn');
        if (viewAnalyzerBtn) {
            viewAnalyzerBtn.addEventListener('click', () => {
                if (window.app) {
                    window.app.showView('analyzer');
                }
            });
        }
    }

    function setupGmailSocketListeners() {
        if (!window.app || !window.app.socket) {
            setTimeout(setupGmailSocketListeners, 500);
            return;
        }

        const socket = window.app.socket;

        socket.on('gmail-progress', (data) => {
            updateGmailProgress(data);
        });

        socket.on('gmail-complete', (data) => {
            handleGmailComplete(data);
        });

        socket.on('gmail-error', (data) => {
            handleGmailError(data);
        });

        resumeGmailJobFromStorage();
    }

    function persistActiveGmailJob(jobInfo) {
        if (!jobInfo || !jobInfo.jobId) return;
        const payload = {
            jobId: jobInfo.jobId,
            startedAt: jobInfo.startedAt || Date.now(),
            filters: jobInfo.filters || null
        };
        gmailState.activeJobId = payload.jobId;
        localStorage.setItem(ACTIVE_GMAIL_JOB_KEY, JSON.stringify(payload));
    }

    function getStoredActiveGmailJob() {
        try {
            const raw = localStorage.getItem(ACTIVE_GMAIL_JOB_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (err) {
            return null;
        }
    }

    function clearStoredActiveGmailJob() {
        gmailState.activeJobId = null;
        localStorage.removeItem(ACTIVE_GMAIL_JOB_KEY);
        stopGmailJobPolling();
    }

    async function attachSocketToJob(jobId) {
        if (!jobId || !window.app?.socket?.id) return;
        try {
            await fetch(`/api/jobs/${jobId}/attach-socket`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ socketId: window.app.socket.id })
            });
        } catch (err) {
            console.warn('Failed to attach socket to Gmail job', err);
        }
    }

    async function fetchJobState(jobId) {
        if (!jobId) return null;
        try {
            const res = await fetch(`/api/jobs/${jobId}`);
            if (!res.ok) return null;
            const data = await res.json();
            return data?.job || null;
        } catch (err) {
            console.warn('Failed to fetch Gmail job state', err);
            return null;
        }
    }

    async function hydrateGmailJob(jobId) {
        const job = await fetchJobState(jobId);
        if (!job) return;
        applyJobStateToUI(job, { fromPoll: true });
    }

    function startGmailJobPolling(jobId) {
        if (!jobId) return;
        stopGmailJobPolling();
        gmailJobPollTimer = setInterval(() => {
            hydrateGmailJob(jobId);
        }, 5000);
    }

    function stopGmailJobPolling() {
        if (gmailJobPollTimer) {
            clearInterval(gmailJobPollTimer);
            gmailJobPollTimer = null;
        }
    }

    async function resumeGmailJob(jobId) {
        if (!jobId) return;
        if (!window.app?.socket?.id) {
            setTimeout(() => resumeGmailJob(jobId), 500);
            return;
        }
        gmailState.activeJobId = jobId;
        showGmailSection('processing');
        await attachSocketToJob(jobId);
        await hydrateGmailJob(jobId);
        startGmailJobPolling(jobId);
    }

    function resumeGmailJobFromStorage() {
        const saved = getStoredActiveGmailJob();
        if (saved?.jobId) {
            resumeGmailJob(saved.jobId);
        }
    }

    function handleStorageSync(event) {
        if (event.key !== ACTIVE_GMAIL_JOB_KEY) return;
        if (!event.newValue) {
            clearStoredActiveGmailJob();
            return;
        }
        try {
            const payload = JSON.parse(event.newValue);
            if (payload?.jobId && payload.jobId !== gmailState.activeJobId) {
                resumeGmailJob(payload.jobId);
            }
        } catch (err) {
            console.warn('Failed to sync Gmail job storage payload', err);
        }
    }

    function saveGmailCredentials() {
        const clientId = document.getElementById('gmail-client-id').value.trim();
        const clientSecret = document.getElementById('gmail-client-secret').value.trim();

        if (!clientId || !clientSecret) {
            if (window.app) {
                window.app.showNotification('Please enter both Client ID and Client Secret', 'error');
            }
            return;
        }

        localStorage.setItem('chunhr-gmail-client-id', clientId);
        localStorage.setItem('chunhr-gmail-client-secret', clientSecret);
        gmailState.credentials = { clientId, clientSecret };

        if (window.app) {
            window.app.showNotification('Gmail credentials saved successfully!', 'success');
        }

        updateGmailConnectionUI();
    }

    async function initiateGmailAuth() {
        if (!gmailState.credentials || !gmailState.credentials.clientId || !gmailState.credentials.clientSecret) {
            if (window.app) {
                window.app.showNotification('Please configure Gmail credentials in Settings first', 'error');
                window.app.showView('settings');
            }
            return;
        }

        try {
            // Store credentials in sessionStorage for callback to access
            sessionStorage.setItem('gmail-pending-auth', JSON.stringify(gmailState.credentials));
            
            // Get auth URL from backend
            const response = await fetch('/api/gmail-workspace/init-auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(gmailState.credentials)
            });

            const data = await response.json();

            if (!data.success) {
                throw new Error(data.error || 'Failed to initialize authentication');
            }

            // Open auth URL in popup
            const width = 600;
            const height = 700;
            const left = (screen.width - width) / 2;
            const top = (screen.height - height) / 2;
            
            console.log('🚀 Opening OAuth popup window:', data.authUrl);
            const popup = window.open(
                data.authUrl,
                'Gmail Authorization',
                `width=${width},height=${height},left=${left},top=${top}`
            );
            
            if (!popup) {
                throw new Error('Failed to open popup window. Please allow popups for this site.');
            }
            console.log('✅ Popup window opened successfully');
            
            // Poll localStorage for auth completion (since window.opener may be lost)
            const authCheckInterval = setInterval(() => {
                const authComplete = localStorage.getItem('chunhr-gmail-auth-complete');
                if (authComplete) {
                    console.log('✅ Detected auth completion in localStorage');
                    clearInterval(authCheckInterval);
                    localStorage.removeItem('chunhr-gmail-auth-complete');
                    
                    // Load tokens
                    const tokensStr = localStorage.getItem('chunhr-gmail-tokens');
                    if (tokensStr) {
                        try {
                            const tokens = JSON.parse(tokensStr);
                            gmailState.tokens = tokens;
                            gmailState.isConnected = true;
                            console.log('✅ Gmail tokens loaded from localStorage');
                            
                            // Update UI
                            updateGmailConnectionUI();
                            
                            // Refresh the view to show updated connection status
                            if (window.app && window.app.currentView === 'gmail-workspace') {
                                console.log('🔄 Refreshing Gmail Workspace view');
                                window.app.showView('gmail-workspace');
                            }
                            
                            if (window.app) {
                                window.app.showNotification('Gmail connected successfully!', 'success');
                            }
                        } catch (e) {
                            console.error('❌ Failed to parse tokens:', e);
                        }
                    }
                }
                
                // Stop polling if popup is closed
                if (popup.closed) {
                    console.log('🚨 Popup closed, stopping auth check');
                    clearInterval(authCheckInterval);
                }
            }, 500); // Check every 500ms
            
            // Safety timeout - stop polling after 2 minutes
            setTimeout(() => {
                clearInterval(authCheckInterval);
                console.log('⏱️ Auth polling timeout');
            }, 120000);

        } catch (error) {
            console.error('Error initiating Gmail auth:', error);
            if (window.app) {
                window.app.showNotification('Failed to start authorization: ' + error.message, 'error');
            }
        }
    }

    function handleOAuthMessage(event) {
        console.log('📬 Received postMessage:', event.type, 'from', event.origin);
        console.log('📬 Message data:', event.data);
        
        // Allow localhost, 127.0.0.1, and ::1 origins during development
        const allowedOrigins = new Set([
            window.location.origin,
            `http://localhost:${window.location.port}`,
            `http://127.0.0.1:${window.location.port}`,
            `http://[::1]:${window.location.port}`
        ]);
        console.log('🔍 Allowed origins:', Array.from(allowedOrigins));
        console.log('🔍 Event origin:', event.origin);
        
        if (!allowedOrigins.has(event.origin)) {
            console.log('⚠️ Ignoring message from disallowed origin:', event.origin);
            return;
        }
        console.log('✅ Origin allowed, processing message');
    
        
        if (event.data && event.data.type === 'gmail-auth-success') {
            console.log('✅ Received Gmail auth success message');
            const tokens = event.data.tokens;
            
            // Store tokens
            try {
                localStorage.setItem('chunhr-gmail-tokens', JSON.stringify(tokens));
                gmailState.tokens = tokens;
                gmailState.isConnected = true;
                console.log('✅ Gmail tokens stored successfully');
            } catch (e) {
                console.error('❌ Failed to store Gmail tokens:', e);
            }
            
            // Update UI
            updateGmailConnectionUI();
            
            if (window.app) {
                window.app.showNotification('Gmail connected successfully!', 'success');
            }
        }
    }

    function disconnectGmail() {
        localStorage.removeItem('chunhr-gmail-tokens');
        gmailState.tokens = null;
        gmailState.isConnected = false;
        
        updateGmailConnectionUI();
        
        if (window.app) {
            window.app.showNotification('Gmail disconnected', 'info');
        }
    }

    async function testGmailConnection() {
        if (!gmailState.isConnected) {
            if (window.app) {
                window.app.showNotification('Please connect Gmail first', 'error');
            }
            return;
        }

        try {
            const response = await fetch('/api/gmail-workspace/test-connection', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...gmailState.credentials,
                    tokens: gmailState.tokens
                })
            });

            const data = await response.json();

            if (data.success) {
                if (window.app) {
                    window.app.showNotification(
                        `✅ Connected as ${data.email} (${data.messagesTotal} messages)`,
                        'success'
                    );
                }
            } else {
                throw new Error(data.error || 'Connection test failed');
            }
        } catch (error) {
            console.error('Error testing connection:', error);
            if (window.app) {
                window.app.showNotification('Connection test failed: ' + error.message, 'error');
            }
        }
    }

    function updateGmailConnectionUI() {
        const notConnected = document.getElementById('gmail-not-connected');
        const connected = document.getElementById('gmail-connected');
        const filterForm = document.getElementById('gmail-filter-form');

        if (gmailState.isConnected) {
            notConnected?.classList.add('hidden');
            connected?.classList.remove('hidden');
            filterForm?.classList.remove('hidden');
            
            // Try to get email if available
            if (gmailState.tokens && gmailState.tokens.id_token) {
                // Could decode JWT to get email, but for now just show connected status
            }
        } else {
            notConnected?.classList.remove('hidden');
            connected?.classList.add('hidden');
            filterForm?.classList.add('hidden');
        }

        // Update settings status
        const settingsStatus = document.getElementById('gmail-settings-status-text');
        if (settingsStatus) {
            if (gmailState.credentials && gmailState.credentials.clientId) {
                if (gmailState.isConnected) {
                    settingsStatus.textContent = '✅ Connected';
                    settingsStatus.style.color = '#10b981';
                } else {
                    settingsStatus.textContent = '⚙️ Configured (not connected)';
                    settingsStatus.style.color = '#f59e0b';
                }
            } else {
                settingsStatus.textContent = 'Not configured';
                settingsStatus.style.color = '#64748b';
            }
        }
    }

    async function startFetchingResumes() {
        if (!gmailState.isConnected) {
            if (window.app) {
                window.app.showNotification('Please connect Gmail first', 'error');
            }
            return;
        }

        clearStoredActiveGmailJob();

        // Get filter values
        let days = null;
        const customDays = document.getElementById('gmail-custom-days').value;
        
        if (customDays && parseInt(customDays) > 0) {
            days = parseInt(customDays);
        } else {
            // Get selected radio button
            const selectedRadio = document.querySelector('input[name="gmail-days"]:checked');
            if (selectedRadio) {
                days = parseInt(selectedRadio.value);
            }
        }

        const textFilter = document.getElementById('gmail-text-filter').value.trim();

        const filters = {
            days: days || 30, // Default to 30 days
            textFilter: textFilter
        };

        // Show processing section
        showGmailSection('processing');

        try {
            const response = await fetch('/api/gmail-workspace/fetch-resumes', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ...gmailState.credentials,
                    tokens: gmailState.tokens,
                    filters: filters,
                    socketId: window.app?.socket?.id
                })
            });

            const data = await response.json();

            if (!data.success) {
                throw new Error(data.error || 'Failed to fetch resumes');
            }

        } catch (error) {
            console.error('Error fetching resumes:', error);
            if (window.app) {
                window.app.showNotification('Failed to fetch resumes: ' + error.message, 'error');
            }
            clearStoredActiveGmailJob();
            showGmailSection('intro');
        }
    }

    function showGmailSection(section) {
        const sections = ['intro', 'processing', 'results'];
        sections.forEach(s => {
            const elem = document.getElementById(`gmail-${s === 'intro' ? 'workspace-intro' : s}-section`);
            if (elem) {
                elem.classList.toggle('hidden', s !== section);
            }
        });
    }

    function updateGmailProgress(data = {}, options = {}) {
        if (data.jobId) {
            if (gmailState.activeJobId !== data.jobId) {
                gmailState.activeJobId = data.jobId;
                persistActiveGmailJob({ jobId: data.jobId });
            }
            if (!gmailJobPollTimer && gmailState.activeJobId) {
                startGmailJobPolling(gmailState.activeJobId);
            }
        }

        const progressFill = document.getElementById('gmail-progress-fill');
        const progressPercentage = document.getElementById('gmail-progress-percentage');
        const progressStatus = document.getElementById('gmail-progress-status');

        if (progressFill && typeof data.progress === 'number') {
            progressFill.style.width = `${Math.max(0, Math.min(100, data.progress))}%`;
        }

        if (progressPercentage && typeof data.progress === 'number') {
            progressPercentage.textContent = `${Math.round(data.progress)}%`;
        }

        if (progressStatus && data.message) {
            progressStatus.textContent = data.message;
        }

        if (options.replaceLogs && Array.isArray(data.logs)) {
            renderGmailLogs(data.logs);
        } else if (data.message && !options.skipLog) {
            appendGmailLog(data.message);
        }
    }

    function appendGmailLog(message, timestamp = Date.now()) {
        if (!message) return;
        const processingLog = document.getElementById('gmail-processing-log');
        if (!processingLog) return;
        const logEntry = document.createElement('div');
        logEntry.className = 'log-entry';
        logEntry.textContent = `[${new Date(timestamp).toLocaleTimeString()}] ${message}`;
        processingLog.appendChild(logEntry);
        processingLog.scrollTop = processingLog.scrollHeight;
    }

    function renderGmailLogs(logs = []) {
        const processingLog = document.getElementById('gmail-processing-log');
        if (!processingLog) return;
        processingLog.innerHTML = '';
        logs.slice(-100).forEach((entry) => {
            const msg = entry?.message || entry?.text || '';
            const ts = entry?.ts || Date.now();
            appendGmailLog(msg, ts);
        });
    }

    function applyJobStateToUI(job, options = {}) {
        if (!job) return;
        const status = job.status || 'running';
        if (status === 'completed') {
            handleGmailComplete({ jobId: job.id, message: job.message, stats: job.stats });
            return;
        }
        if (status === 'failed') {
            handleGmailError({ jobId: job.id, error: job.message || job.error });
            return;
        }

        gmailState.activeJobId = job.id;
        persistActiveGmailJob({ jobId: job.id, filters: job.metadata?.filters || null });
        showGmailSection('processing');
        updateGmailProgress({
            jobId: job.id,
            progress: typeof job.progress === 'number' ? job.progress : 0,
            message: job.message || 'Processing resumes...',
            stage: job.stage,
            logs: job.logs
        }, { replaceLogs: true, skipLog: true });
    }

    function handleGmailComplete(data) {
        clearStoredActiveGmailJob();
        showGmailSection('results');

        const statsGrid = document.getElementById('gmail-results-stats');
        if (statsGrid && data.stats) {
            statsGrid.innerHTML = `
                <div class="stat-card" style="padding: 1.5rem; background: rgba(255,255,255,0.05); border-radius: 12px; text-align: center;">
                    <div style="font-size: 2rem; margin-bottom: 0.5rem;">📧</div>
                    <div style="font-size: 2rem; font-weight: 600; margin-bottom: 0.25rem;">${data.stats.emailsScanned || 0}</div>
                    <div style="opacity: 0.7; font-size: 0.875rem;">Emails Scanned</div>
                </div>
                <div class="stat-card" style="padding: 1.5rem; background: rgba(255,255,255,0.05); border-radius: 12px; text-align: center;">
                    <div style="font-size: 2rem; margin-bottom: 0.5rem;">📄</div>
                    <div style="font-size: 2rem; font-weight: 600; margin-bottom: 0.25rem;">${data.stats.pdfsFound || 0}</div>
                    <div style="opacity: 0.7; font-size: 0.875rem;">PDFs Found</div>
                </div>
                <div class="stat-card" style="padding: 1.5rem; background: rgba(255,255,255,0.05); border-radius: 12px; text-align: center;">
                    <div style="font-size: 2rem; margin-bottom: 0.5rem;">✅</div>
                    <div style="font-size: 2rem; font-weight: 600; margin-bottom: 0.25rem;">${data.stats.resumesProcessed || data.stats.resumesDownloaded || 0}</div>
                    <div style="opacity: 0.7; font-size: 0.875rem;">Resumes Processed</div>
                </div>
                ${data.stats.errors ? `
                <div class="stat-card" style="padding: 1.5rem; background: rgba(239,68,68,0.1); border-radius: 12px; text-align: center;">
                    <div style="font-size: 2rem; margin-bottom: 0.5rem;">⚠️</div>
                    <div style="font-size: 2rem; font-weight: 600; margin-bottom: 0.25rem;">${data.stats.errors}</div>
                    <div style="opacity: 0.7; font-size: 0.875rem;">Errors</div>
                </div>
                ` : ''}
            `;
        }

        if (window.app) {
            window.app.showNotification(data.message || 'Resume extraction complete!', 'success');
        }
    }

    function handleGmailError(data) {
        clearStoredActiveGmailJob();
        console.error('Gmail error:', data);
        
        if (window.app) {
            window.app.showNotification('Error: ' + (data.error || 'Unknown error'), 'error');
        }
        
        showGmailSection('intro');
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initGmailWorkspace);
    } else {
        initGmailWorkspace();
    }

    // Export for debugging
    window.gmailWorkspace = {
        state: gmailState,
        updateUI: updateGmailConnectionUI,
        test: testGmailConnection
    };

})();
