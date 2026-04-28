require('dotenv').config({ quiet: true });

const { setupDatabase } = require('./src/databaseSetup');
const {
    ensureRuntimeDirectories,
    getDatabasePath,
    getWritableDataRoot,
    isDesktopRuntime
} = require('./src/core/runtimePaths');

async function initializeHrAnalyzer() {
    console.log('Initializing Hr Analyzer submission demo...');

    try {
        ensureRuntimeDirectories();
        console.log(`Runtime data directory: ${getWritableDataRoot()}`);
        console.log(`Database path: ${getDatabasePath()}`);
        if (isDesktopRuntime()) {
            console.log('Desktop runtime detected');
        }

        console.log('Setting up database...');
        await setupDatabase();

        console.log('Starting Hr Analyzer server...');
        const { startServer } = require('./server');
        startServer();
    } catch (error) {
        console.error('Failed to initialize Hr Analyzer:', error);
        process.exit(1);
    }
}

initializeHrAnalyzer();
