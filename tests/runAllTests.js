const fs = require('fs');
const path = require('path');

const testsDir = __dirname;
const files = fs
    .readdirSync(testsDir)
    .filter((name) => name.endsWith('.test.js'))
    .sort();

for (const file of files) {
    // eslint-disable-next-line no-console
    console.log(`\n>>> ${file}`);
    require(path.join(testsDir, file));
}

// eslint-disable-next-line no-console
console.log('\nAll standalone tests executed.');
