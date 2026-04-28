const fs = require('fs');
const os = require('os');
const path = require('path');

const SOURCE_ROOT = path.resolve(__dirname, '..', '..');
const CLI_ARGS = process.argv.slice(2);

function readArg(flagName) {
    const flag = `--${flagName}`;
    const withValue = `${flag}=`;

    for (let i = 0; i < CLI_ARGS.length; i += 1) {
        const current = CLI_ARGS[i];
        if (current === flag) {
            return CLI_ARGS[i + 1] || null;
        }
        if (current.startsWith(withValue)) {
            return current.slice(withValue.length);
        }
    }

    return null;
}

function hasFlag(flagName) {
    return CLI_ARGS.includes(`--${flagName}`);
}

function resolveDefaultDataRoot() {
    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
        return path.join(localAppData, 'Hr Analyzer');
    }

    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'Hr Analyzer');
    }

    const xdgDataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    return path.join(xdgDataHome, 'hr-analyzer');
}

function getSourceRoot() {
    return SOURCE_ROOT;
}

function getWritableDataRoot() {
    const explicitDir = readArg('data-dir') || process.env.HR_ANALYZER_DATA_DIR;
    if (explicitDir) {
        return path.resolve(explicitDir);
    }

    if (!process.pkg && process.env.HR_ANALYZER_FORCE_APPDATA !== '1') {
        return SOURCE_ROOT;
    }

    return resolveDefaultDataRoot();
}

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
    return dirPath;
}

function getDatabasePath() {
    const configured = readArg('db-path') || process.env.DB_PATH || 'analyzer.db';
    if (path.isAbsolute(configured)) {
        return configured;
    }
    return path.join(getWritableDataRoot(), configured);
}

function getTempUploadsDir() {
    return path.join(getWritableDataRoot(), 'temp_uploads');
}

function getResumesDir() {
    return path.join(getWritableDataRoot(), 'resumes');
}

function getModelsDir() {
    return path.join(getWritableDataRoot(), 'models');
}

function getTransformersCacheDir() {
    return path.join(getWritableDataRoot(), 'transformers-cache');
}

function getTransformersCacheMarker() {
    return path.join(getWritableDataRoot(), '.cache-cleared');
}

function getTransformersCacheLock() {
    return path.join(getWritableDataRoot(), '.cache-clearing');
}

function getPublicDir() {
    return path.join(getSourceRoot(), 'public');
}

function getNodeModulesDir() {
    return path.join(getSourceRoot(), 'node_modules');
}

function getPort(defaultPort = 3000) {
    const raw = readArg('port') || process.env.PORT || defaultPort;
    const port = parseInt(raw, 10);
    return Number.isFinite(port) && port > 0 ? port : defaultPort;
}

function isDesktopRuntime() {
    return hasFlag('desktop') || process.env.HR_ANALYZER_DESKTOP === '1' || process.env.TAURI_DESKTOP === '1';
}

function getHost() {
    if (process.env.HR_ANALYZER_HOST) {
        return process.env.HR_ANALYZER_HOST;
    }
    return isDesktopRuntime() ? '127.0.0.1' : undefined;
}

function shouldAutoOpenBrowser() {
    return process.env.DISABLE_AUTO_OPEN !== '1' && process.env.NODE_ENV !== 'production' && !isDesktopRuntime();
}

function ensureRuntimeDirectories() {
    const root = ensureDir(getWritableDataRoot());
    const tempUploads = ensureDir(getTempUploadsDir());
    const resumes = ensureDir(getResumesDir());
    const models = ensureDir(getModelsDir());

    return { root, tempUploads, resumes, models };
}

module.exports = {
    ensureDir,
    ensureRuntimeDirectories,
    getDatabasePath,
    getHost,
    getModelsDir,
    getNodeModulesDir,
    getPort,
    getPublicDir,
    getResumesDir,
    getSourceRoot,
    getTempUploadsDir,
    getTransformersCacheDir,
    getTransformersCacheLock,
    getTransformersCacheMarker,
    getWritableDataRoot,
    isDesktopRuntime,
    readArg,
    shouldAutoOpenBrowser
};
