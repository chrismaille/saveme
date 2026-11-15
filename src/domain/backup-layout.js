import {parseVersionTimestamp, versionTimestamp} from './time.js';

export function backupRootFor(job, dest) {
    if (job.destination?.kind === 'remote' && !String(dest).includes(':'))
        throw new Error(`Invalid remote destination: ${dest}`);
    return `${backupContainerFor(dest)}/${job.id}`;
}

export function backupCurrentFor(job, dest) {
    return `${backupRootFor(job, dest)}/current`;
}

export function syncRootFor(job, dest) {
    if (job.destinationLayout === 'direct')
        return dest;
    return backupCurrentFor(job, dest);
}

export function versionsRootFor(job, dest) {
    return `${backupRootFor(job, dest)}/versions`;
}

export function joinRclonePath(base, rel) {
    if (!rel)
        return base;
    if (base.endsWith(':') || base.endsWith('/'))
        return `${base}${rel}`;
    return `${base}/${rel}`;
}

export function rcloneBasename(path) {
    const raw = String(path ?? '');
    if (/^\/+$/.test(raw))
        return '/';
    const value = raw.replace(/\/+$/, '');
    if (!value)
        return '';
    const index = value.lastIndexOf('/');
    return index >= 0 ? value.slice(index + 1) : value;
}

export function versionName(date, runId = '') {
    const suffix = String(runId || '').slice(-6);
    const millis = String(date.getMilliseconds()).padStart(3, '0');
    const base = `${versionTimestamp(date)}-${millis}`;
    return suffix ? `${base}-${suffix}` : base;
}

export function versionDirFor(versionsRoot, runId, date = new Date()) {
    return `${versionsRoot}/${versionName(date, runId)}`;
}

export function isValidVersionName(name) {
    return parseVersionTimestamp(name) !== null && !String(name).includes('/');
}

export function isSafeRelativePath(path) {
    return !String(path).split('/').some(part => part === '..');
}

export function backupContainerFor(dest) {
    if (String(dest).includes(':') && /^[^/]+:/.test(String(dest))) {
        const colon = String(dest).indexOf(':');
        const remote = String(dest).slice(0, colon);
        const remotePath = String(dest).slice(colon + 1).replace(/\/+$/, '');
        return remotePath ? `${remote}:${remotePath}/SaveMe` : `${remote}:SaveMe`;
    }
    return `${String(dest).replace(/\/+$/, '')}/SaveMe`;
}

export function sourceFolderName(descriptor, index = 0) {
    const raw = descriptor?.path || '';
    const base = rcloneBasename(raw);
    const safe = base
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '');
    return safe || `source-${index + 1}`;
}

export function uniqueSourceFolderNames(job) {
    const used = new Set();
    return (job.sources?.length ? job.sources : [job.source]).map((source, index) => {
        const base = sourceFolderName(source, index);
        let name = base;
        let suffix = 2;
        while (used.has(name))
            name = `${base}-${suffix++}`;
        used.add(name);
        return name;
    });
}
