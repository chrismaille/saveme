import GLib from 'gi://GLib';

const KIB = 1024;

export function parseProcStatus(text) {
    const result = {rssBytes: 0, peakRssBytes: 0, virtualBytes: 0};
    for (const line of String(text || '').split('\n')) {
        const match = /^(VmRSS|VmHWM|VmSize):\s+(\d+)\s+kB/.exec(line.trim());
        if (!match)
            continue;
        const bytes = Number(match[2]) * KIB;
        if (match[1] === 'VmRSS')
            result.rssBytes = bytes;
        else if (match[1] === 'VmHWM')
            result.peakRssBytes = bytes;
        else
            result.virtualBytes = bytes;
    }
    return result;
}

export function parseProcStat(text) {
    const value = String(text || '');
    const close = value.lastIndexOf(')');
    if (close < 0)
        return {utimeTicks: 0, stimeTicks: 0, startTicks: 0};
    const fields = value.slice(close + 2).trim().split(/\s+/);
    const number = index => Number(fields[index]) || 0;
    return {
        utimeTicks: number(11),
        stimeTicks: number(12),
        startTicks: number(19),
    };
}

export function cpuPercent(previous, current, ticksPerSecond = 100) {
    if (!previous || !current)
        return 0;
    const elapsedMs = Number(current.sampledAtMs) - Number(previous.sampledAtMs);
    if (!(elapsedMs > 0))
        return 0;
    const previousTicks = Number(previous.utimeTicks || 0) +
        Number(previous.stimeTicks || 0);
    const currentTicks = Number(current.utimeTicks || 0) +
        Number(current.stimeTicks || 0);
    const deltaTicks = Math.max(0, currentTicks - previousTicks);
    return Math.max(0, deltaTicks / Math.max(1, ticksPerSecond) /
        (elapsedMs / 1000) * 100);
}

export function readProcessMetrics({
    statusPath = '/proc/self/status',
    statPath = '/proc/self/stat',
    nowMs = Date.now(),
} = {}) {
    try {
        const read = path => {
            const [ok, bytes] = GLib.file_get_contents(path);
            if (!ok)
                throw new Error(`Cannot read ${path}`);
            return new TextDecoder().decode(bytes);
        };
        return {
            ...parseProcStatus(read(statusPath)),
            ...parseProcStat(read(statPath)),
            sampledAtMs: nowMs,
        };
    } catch (_) {
        return null;
    }
}
