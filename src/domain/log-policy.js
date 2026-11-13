const SECRET_KEY = '(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|' +
    'client[_-]?secret|api[_-]?key|apikey|password|passwd|secret|authorization)';
const KEY_VALUE_RE = new RegExp(
    `(${SECRET_KEY}\\s*["']?\\s*[:=]\\s*["']?)([^\\s"',;}&]+)`, 'gi');
const URL_SECRET_RE =
    /([?&](?:code|token|access_token|refresh_token|id_token|client_secret|password|state)=)[^&\s#]+/gi;
const BEARER_RE = /(authorization\s*[:=]\s*bearer\s+)[^\s"',;]+/gi;
const PRIVATE_KEY_RE =
    /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g;

export const DEFAULT_LOG_POLICY = Object.freeze({
    retentionDays: 30,
    maxTotalBytes: 50 * 1024 * 1024,
    protectModifiedWithinMs: 60_000,
});

/**
 * Redact credentials that may appear in rclone, OAuth or D-Bus diagnostics.
 * The function is idempotent and keeps JSON structure valid.
 */
export function sanitizeLogText(value) {
    let text = String(value ?? '');
    if (!text)
        return text;
    text = text.replace(BEARER_RE, '$1[REDACTED]');
    text = text.replace(KEY_VALUE_RE, '$1[REDACTED]');
    text = text.replace(URL_SECRET_RE, '$1[REDACTED]');
    text = text.replace(PRIVATE_KEY_RE, '[REDACTED PRIVATE KEY]');
    return text;
}

function protectRecent(entry, nowMs, protectModifiedWithinMs) {
    if (!Number.isFinite(protectModifiedWithinMs) || protectModifiedWithinMs <= 0)
        return false;
    return nowMs - Number(entry.mtimeMs || 0) < protectModifiedWithinMs;
}

/**
 * Plan log deletion from the oldest files first. Age deletion is explicit;
 * size deletion never touches files modified within the protection window.
 */
export function planLogCleanup(entries, {
    nowMs = Date.now(),
    retentionDays = DEFAULT_LOG_POLICY.retentionDays,
    maxTotalBytes = DEFAULT_LOG_POLICY.maxTotalBytes,
    protectModifiedWithinMs = DEFAULT_LOG_POLICY.protectModifiedWithinMs,
} = {}) {
    const valid = entries.filter(entry => entry?.path);
    const deleted = new Map();
    const cutoff = nowMs - Math.max(0, Number(retentionDays) || 0) * 86_400_000;

    if (Number(retentionDays) > 0) {
        for (const entry of valid) {
            if (Number(entry.mtimeMs || 0) < cutoff)
                deleted.set(entry.path, entry);
        }
    }

    let remainingBytes = valid
        .filter(entry => !deleted.has(entry.path))
        .reduce((sum, entry) => sum + Math.max(0, Number(entry.size) || 0), 0);
    const limit = Number(maxTotalBytes) || 0;
    if (limit > 0 && remainingBytes > limit) {
        const candidates = valid
            .filter(entry => !deleted.has(entry.path))
            .filter(entry => !protectRecent(entry, nowMs, protectModifiedWithinMs))
            .sort((a, b) => Number(a.mtimeMs || 0) - Number(b.mtimeMs || 0));
        for (const entry of candidates) {
            if (remainingBytes <= limit)
                break;
            deleted.set(entry.path, entry);
            remainingBytes -= Math.max(0, Number(entry.size) || 0);
        }
    }

    const deletedEntries = [...deleted.values()];
    return {
        deleted: deletedEntries,
        paths: deletedEntries.map(entry => entry.path),
        bytesFreed: deletedEntries.reduce(
            (sum, entry) => sum + Math.max(0, Number(entry.size) || 0), 0),
        remainingBytes: Math.max(0, remainingBytes),
    };
}

export function summarizeLogEntries(entries) {
    const areas = {};
    let totalBytes = 0;
    let oldestMs = null;
    let newestMs = null;
    for (const entry of entries) {
        const size = Math.max(0, Number(entry.size) || 0);
        const mtime = Number(entry.mtimeMs) || 0;
        totalBytes += size;
        const area = entry.area || 'other';
        if (!areas[area])
            areas[area] = {bytes: 0, files: 0};
        areas[area].bytes += size;
        areas[area].files += 1;
        if (mtime > 0 && (oldestMs === null || mtime < oldestMs))
            oldestMs = mtime;
        if (mtime > 0 && (newestMs === null || mtime > newestMs))
            newestMs = mtime;
    }
    return {
        totalBytes,
        files: entries.length,
        oldest: oldestMs === null ? null : new Date(oldestMs).toISOString(),
        newest: newestMs === null ? null : new Date(newestMs).toISOString(),
        areas,
    };
}
