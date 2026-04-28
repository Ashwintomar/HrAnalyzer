const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const binariesDir = path.join(projectRoot, 'src-tauri', 'binaries');
const sidecarBaseName = 'node-runtime';

function getRustTargetTriple() {
    const output = execFileSync('rustc', ['-vV'], {
        cwd: projectRoot,
        encoding: 'utf8'
    });
    const match = output.match(/^host:\s+(.+)$/m);
    if (!match) {
        throw new Error('Unable to determine the current Rust target triple.');
    }
    return match[1].trim();
}

function buildSidecar() {
    const targetTriple = getRustTargetTriple();
    const ext = targetTriple.includes('windows') ? '.exe' : '';
    const sourceBinary = process.execPath;
    const outputBinary = path.join(binariesDir, `${sidecarBaseName}-${targetTriple}${ext}`);

    fs.mkdirSync(binariesDir, { recursive: true });
    fs.copyFileSync(sourceBinary, outputBinary);

    console.log(`Bundled Node runtime sidecar from ${sourceBinary}`);
    console.log(`Sidecar ready at ${outputBinary}`);
}

buildSidecar();
