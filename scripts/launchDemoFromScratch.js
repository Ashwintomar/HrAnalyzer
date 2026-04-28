const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const demoReportFile = 'Impact_on_HR_Processes_Using_AI_India_Report.pdf';
const demoReportPath = path.join(projectRoot, demoReportFile);

function runCommand(command, args, options = {}) {
    const { optional = false, env = {} } = options;

    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: projectRoot,
            stdio: 'inherit',
            env: { ...process.env, ...env }
        });

        child.on('error', (error) => {
            if (optional) return resolve(false);
            reject(error);
        });

        child.on('close', (code) => {
            if (code === 0) return resolve(true);
            if (optional) return resolve(false);
            reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}`));
        });
    });
}

async function ensureNpmAvailable() {
    const ok = await runCommand(npmCmd, ['--version'], { optional: true });
    if (!ok) {
        throw new Error('npm is not available. Please install Node.js with npm included.');
    }
}

function ensureRuntimeFolders() {
    const folders = ['temp_uploads', 'resumes', 'models'];
    for (const folder of folders) {
        const folderPath = path.join(projectRoot, folder);
        if (!fs.existsSync(folderPath)) {
            fs.mkdirSync(folderPath, { recursive: true });
            console.log(`📁 Created missing folder: ${folder}`);
        }
    }
}

function ensureEnvFile() {
    const envPath = path.join(projectRoot, '.env');
    if (fs.existsSync(envPath)) return;

    const defaultEnv = [
        '# Hr Analyzer Environment Configuration',
        'PORT=3000',
        'NODE_ENV=development',
        'AI_MODEL=Xenova/all-MiniLM-L6-v2',
        'MAX_WORKERS=10',
        'MAX_FILE_SIZE=10485760',
        'DB_PATH=analyzer.db',
        ''
    ].join('\n');

    fs.writeFileSync(envPath, defaultEnv, 'utf8');
    console.log('🧩 Created default .env file');
}

function ensureDemoReportExists() {
    if (fs.existsSync(demoReportPath)) return;

    throw new Error(
        `Required demo file is missing: ${demoReportFile}\n` +
        'This launcher is configured for the project report demo workflow and expects that file at the project root.'
    );
}

async function installDependenciesWithFallbacks() {
    const hasLockfile = fs.existsSync(path.join(projectRoot, 'package-lock.json'));
    const hasNodeModules = fs.existsSync(path.join(projectRoot, 'node_modules'));
    const forceInstall = process.argv.includes('--force-install');

    if (hasNodeModules && !forceInstall) {
        console.log('📦 node_modules already exists. Skipping dependency install (use --force-install to reinstall).');
        return;
    }

    const attempts = hasLockfile
        ? [
            ['ci', '--no-audit', '--no-fund'],
            ['install', '--no-audit', '--no-fund'],
            ['install', '--legacy-peer-deps', '--no-audit', '--no-fund']
        ]
        : [
            ['install', '--no-audit', '--no-fund'],
            ['install', '--legacy-peer-deps', '--no-audit', '--no-fund']
        ];

    let lastError = null;
    for (const args of attempts) {
        const attemptLabel = `npm ${args.join(' ')}`;
        try {
            console.log(`\n📦 Installing dependencies via: ${attemptLabel}`);
            await runCommand(npmCmd, args);
            console.log('✅ Dependency installation completed');
            return;
        } catch (error) {
            lastError = error;
            console.warn(`⚠️ Install attempt failed: ${attemptLabel}`);
        }
    }

    throw lastError || new Error('Failed to install dependencies.');
}

async function rebuildNativeModulesFallback() {
    console.log('\n🛠️ Attempting optional native module rebuild (better-sqlite3, sqlite-vec)...');
    const ok = await runCommand(npmCmd, ['rebuild', 'better-sqlite3', 'sqlite-vec'], { optional: true });
    if (ok) {
        console.log('✅ Native module rebuild completed');
    } else {
        console.warn('⚠️ Native module rebuild skipped/failed; app will rely on existing binaries and built-in fallbacks where possible.');
    }
}

async function startApp() {
    console.log('\n🚀 Starting Hr Analyzer...');
    await runCommand(process.execPath, ['index.js']);
}

async function main() {
    console.log('==============================');
    console.log('Hr Analyzer Demo Bootstrapper');
    console.log('==============================');
    console.log('Submission launcher for the Hr Analyzer project report demo\n');

    const nodeMajor = parseInt((process.versions.node || '0').split('.')[0], 10);
    if (!Number.isFinite(nodeMajor) || nodeMajor < 20) {
        console.warn(`⚠️ Node.js ${process.versions.node} detected. Node.js 20+ is recommended.`);
    }

    ensureDemoReportExists();
    ensureRuntimeFolders();
    ensureEnvFile();
    await ensureNpmAvailable();
    await installDependenciesWithFallbacks();
    await rebuildNativeModulesFallback();
    await startApp();
}

main().catch((error) => {
    console.error('\n❌ Failed to launch Hr Analyzer from scratch.');
    console.error(error && error.message ? error.message : error);
    process.exit(1);
});
