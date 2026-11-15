import {rcloneBasename} from './backup-layout.js';
import {toNumber} from './object.js';

export function isSuccessExit(code) {
    return code === 0 || code === 9;
}

export function exitCodeMessage(code) {
    switch (code) {
    case 0:
        return 'Success';
    case 1:
        return 'Syntax or usage error';
    case 2:
        return 'Error not otherwise categorised';
    case 3:
        return 'Directory not found';
    case 4:
        return 'File not found';
    case 5:
        return 'Temporary error (retries exhausted)';
    case 6:
        return 'Less serious error (some files failed)';
    case 7:
        return 'Fatal error';
    case 8:
        return 'Transfer exceeded maximum duration';
    case 9:
        return 'No files transferred';
    default:
        return `rclone exited with code ${code}`;
    }
}

export function emptyStats() {
    return {
        bytes: 0,
        totalBytes: 0,
        transfers: 0,
        totalTransfers: 0,
        checks: 0,
        totalChecks: 0,
        deletes: 0,
        deletedDirs: 0,
        renames: 0,
        errors: 0,
        listed: 0,
        elapsedTime: 0,
        speed: 0,
        eta: null,
        fatalError: false,
    };
}

export function emptyRcloneStats() {
    return {...emptyStats(), retryError: false};
}

export function parseRcloneLine(line) {
    if (!line || !line.startsWith('{'))
        return null;
    try {
        return JSON.parse(line);
    } catch (_) {
        return null;
    }
}

export function mergeStats(target, incoming) {
    for (const key of Object.keys(incoming)) {
        const value = incoming[key];
        if (value !== null && value !== undefined && key in target)
            target[key] = value;
    }
    return target;
}

export function accumulateStats(target, incoming) {
    for (const key of ['bytes', 'totalBytes', 'transfers', 'totalTransfers',
        'checks', 'totalChecks', 'deletes', 'deletedDirs', 'renames',
        'errors', 'listed', 'elapsedTime']) {
        target[key] += Number(incoming[key] || 0);
    }
    target.speed = incoming.speed ?? target.speed;
    target.eta = incoming.eta ?? target.eta;
    target.fatalError = target.fatalError || Boolean(incoming.fatalError);
    return target;
}

export function publicStats(stats) {
    return {
        bytes: toNumber(stats.bytes),
        totalBytes: toNumber(stats.totalBytes),
        transfers: toNumber(stats.transfers),
        totalTransfers: toNumber(stats.totalTransfers),
        checks: toNumber(stats.checks),
        totalChecks: toNumber(stats.totalChecks),
        deletes: toNumber(stats.deletes),
        deletedDirs: toNumber(stats.deletedDirs),
        renames: toNumber(stats.renames),
        errors: toNumber(stats.errors),
        listed: toNumber(stats.listed),
        elapsedTime: toNumber(stats.elapsedTime),
        speed: toNumber(stats.speed),
        eta: stats.eta ?? null,
        fatalError: Boolean(stats.fatalError),
        retryError: Boolean(stats.retryError),
    };
}

export function progressFromStats(stats, {
    jobId = '',
    runId = '',
    phase = 'running',
    currentPath = null,
} = {}) {
    const total = stats.totalBytes > 0 ? stats.totalBytes : stats.totalTransfers;
    const done = stats.totalBytes > 0 ? stats.bytes : stats.transfers;
    const percent = total > 0 ? Math.max(0, Math.min(100, (done / total) * 100)) : 0;
    return {
        jobId,
        runId,
        phase,
        percent,
        files: stats.transfers,
        totalFiles: stats.totalTransfers,
        bytes: stats.bytes,
        totalBytes: stats.totalBytes,
        deletes: stats.deletes,
        errors: stats.errors,
        speed: stats.speed,
        eta: stats.eta,
        listed: toNumber(stats.listed),
        currentFile: currentPath ? rcloneBasename(currentPath) : null,
        currentPath,
    };
}
