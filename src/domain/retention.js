import {parseVersionTimestamp} from './time.js';

export function retentionCutoff(nowMs, retentionDays) {
    const days = Number(retentionDays || 0);
    if (!Number.isFinite(days) || days <= 0)
        return null;
    return Number(nowMs) - days * 24 * 60 * 60 * 1000;
}

export function selectExpiredVersions(names, {
    nowMs = Date.now(),
    retentionDays = 0,
} = {}) {
    const cutoff = retentionCutoff(nowMs, retentionDays);
    if (cutoff === null)
        return [];
    return names.filter(name => {
        const date = parseVersionTimestamp(name);
        return date !== null && date.getTime() < cutoff;
    });
}
