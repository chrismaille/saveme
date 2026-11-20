import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = String(process.argv[2] || '').trim();

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    console.error(`Invalid semantic version: ${version || '(missing)'}`);
    process.exit(1);
}

function replaceOnce(file, pattern, replacement) {
    const full = path.join(root, file);
    const source = fs.readFileSync(full, 'utf8');
    if (!pattern.test(source)) {
        console.error(`Cannot find the version marker in ${file}`);
        process.exit(1);
    }
    fs.writeFileSync(full, source.replace(pattern, replacement));
}

const packageJsonPath = path.join(root, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
packageJson.version = version;
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

const lockPath = path.join(root, 'package-lock.json');
if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    lock.version = version;
    if (lock.packages?.[''])
        lock.packages[''].version = version;
    fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

replaceOnce('src/daemon.js',
    /const VERSION = '[^']+';/,
    `const VERSION = '${version}';`);
replaceOnce('scripts/build-deb.sh',
    /VERSION="\$\{VERSION:-[^}]+\}"/,
    `VERSION="\${VERSION:-${version}}"`);

const changelogPath = path.join(root, 'debian/changelog');
if (fs.existsSync(changelogPath)) {
    const changelog = fs.readFileSync(changelogPath, 'utf8');
    if (!/^saveme \([^)]+\)/.test(changelog)) {
        console.error('Cannot find the version marker in debian/changelog');
        process.exit(1);
    }
    fs.writeFileSync(changelogPath,
        changelog.replace(/^saveme \([^)]+\)/, `saveme (${version}-0ubuntu1)`));
}

console.log(`SaveMe version updated to ${version}`);
