import {versionTimestamp} from './time.js';

export function backupRootFor(job, dest) {
    if (job.destination.kind === 'remote') {
        const colon = dest.indexOf(':');
        if (colon < 0)
            throw new Error(`Invalid remote destination: ${dest}`);
        const remote = dest.slice(0, colon);
        const remotePath = dest.slice(colon + 1).replace(/\/+$/, '');
        const base = remotePath
            ? `${remotePath}/SaveMe/${job.id}`
            : `SaveMe/${job.id}`;
        return `${remote}:${base}`;
    }
    const base = dest.replace(/\/+$/, '');
    return `${base}/SaveMe/${job.id}`;
}

export function backupCurrentFor(job, dest) {
    return `${backupRootFor(job, dest)}/current`;
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
