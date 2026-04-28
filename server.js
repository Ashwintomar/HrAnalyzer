const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { disposePipeline, setupPipelineSocketEvents } = require('./src/core/pipelineManager');
const { startPeriodicCleanup } = require('./src/core/tempFileCleanup');
const {
    ensureRuntimeDirectories,
    getHost,
    getModelsDir,
    getNodeModulesDir,
    getPort,
    getPublicDir,
    shouldAutoOpenBrowser
} = require('./src/core/runtimePaths');

const app = express();
const server = createServer(app);
const io = new Server(server);

let cleanupStopFn = null;
let processingManager = null;
let routesInitialized = false;
let isShuttingDown = false;

app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(getPublicDir()));
app.use('/models', express.static(getModelsDir()));
app.use('/onnxruntime-web', express.static(path.join(getNodeModulesDir(), 'onnxruntime-web', 'dist')));
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

io.on('connection', (socket) => {
    console.log(`[socket] connected: ${socket.id} (${socket.handshake.address})`);

    socket.on('disconnect', (reason) => {
        console.log(`[socket] disconnected: ${socket.id} (${reason})`);
    });

    setupPipelineSocketEvents(socket);
});

function ensureAppRuntime() {
    if (routesInitialized) {
        return;
    }

    ensureRuntimeDirectories();
    const mainRouter = require('./src/routes');
    processingManager = require('./src/core/workerPool');
    app.use('/api', mainRouter(io));
    routesInitialized = true;
}

function startServer() {
    ensureAppRuntime();

    const port = getPort(3000);
    const host = getHost();

    server.listen(port, host, () => {
        const addressInfo = server.address();
        const activePort = typeof addressInfo === 'object' && addressInfo ? addressInfo.port : port;
        const activeHost = typeof addressInfo === 'object' && addressInfo && addressInfo.address && addressInfo.address !== '::'
            ? addressInfo.address
            : (host || 'localhost');

        console.log(`Hr Analyzer running on http://${activeHost}:${activePort}`);
        console.log(`Dashboard available at http://${activeHost}:${activePort}`);
        console.log('AI pipeline will load lazily on first use');

        cleanupStopFn = startPeriodicCleanup(1, 24);

        if (process.env.SERVER_MEMORY_LOG === '1') {
            const interval = parseInt(process.env.SERVER_MEMORY_LOG_INTERVAL_MS || '15000', 10);
            console.log(`Server memory logging enabled every ${interval}ms`);
            const formatMb = (value) => `${(value / 1024 / 1024).toFixed(1)}MB`;
            const logMem = () => {
                const usage = process.memoryUsage();
                console.log(
                    `[server mem] rss=${formatMb(usage.rss)} heapUsed=${formatMb(usage.heapUsed)} ` +
                    `heapTotal=${formatMb(usage.heapTotal)} ext=${formatMb(usage.external)}`
                );
            };
            logMem();
            setInterval(logMem, interval).unref();
        }

        if (shouldAutoOpenBrowser()) {
            const { exec } = require('child_process');
            exec(`start http://127.0.0.1:${activePort}`);
        }
    });
}

function gracefulShutdown(signal) {
    if (isShuttingDown) {
        return;
    }
    isShuttingDown = true;

    console.log(`\n${signal} received, shutting down gracefully...`);

    server.close(async (err) => {
        if (err) {
            console.error('Error closing server:', err);
        } else {
            console.log('HTTP server closed');
        }

        try {
            if (cleanupStopFn) {
                cleanupStopFn();
                console.log('Temp file cleanup stopped');
            }
        } catch (error) {
            console.error('Error stopping cleanup:', error);
        }

        try {
            disposePipeline();
            console.log('AI pipeline disposed');
        } catch (error) {
            console.error('Error disposing pipeline:', error);
        }

        try {
            if (processingManager) {
                await processingManager.terminateAllWorkers();
                console.log('Worker threads terminated');
            }
        } catch (error) {
            console.error('Error terminating workers:', error);
        }

        console.log('Graceful shutdown completed');
        process.exit(0);
    });

    setTimeout(() => {
        console.log('Forcing shutdown after 10 seconds...');
        process.exit(1);
    }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

if (process.platform === 'win32') {
    process.on('SIGBREAK', () => gracefulShutdown('SIGBREAK'));
}

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    gracefulShutdown('UNHANDLED_REJECTION');
});

module.exports = { startServer, app, server, io };

if (require.main === module) {
    require('dotenv').config({ quiet: true });
    const { setupDatabase } = require('./src/databaseSetup');

    setupDatabase()
        .then(() => startServer())
        .catch((error) => {
            console.error('Failed to bootstrap Hr Analyzer server:', error);
            process.exit(1);
        });
}
