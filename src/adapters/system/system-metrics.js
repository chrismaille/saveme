import GLib from 'gi://GLib';

const KIB = 1024;

export function parseMeminfo(text) {
    const values = {};
    for (const line of String(text || '').split('\n')) {
        const match = /^(MemTotal|MemAvailable|MemFree):\s+(\d+)\s+kB/.exec(line.trim());
        if (match)
            values[match[1]] = Number(match[2]) * KIB;
    }
    const totalBytes = values.MemTotal || 0;
    const freeBytes = values.MemAvailable ?? values.MemFree ?? 0;
    return {
        totalBytes,
        freeBytes,
        usedBytes: Math.max(0, totalBytes - freeBytes),
    };
}

export function parseCpuStat(text) {
    const line = String(text || '').split('\n').find(item => /^cpu\s/.test(item.trim()));
    if (!line)
        return {idleTicks: 0, totalTicks: 0};
    const values = line.trim().split(/\s+/).slice(1).map(Number);
    const totalTicks = values.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
    const idleTicks = (values[3] || 0) + (values[4] || 0);
    return {idleTicks, totalTicks};
}

export function cpuPercentFromSamples(previous, current) {
    if (!previous || !current)
        return 0;
    const total = Number(current.totalTicks) - Number(previous.totalTicks);
    const idle = Number(current.idleTicks) - Number(previous.idleTicks);
    if (!(total > 0))
        return 0;
    return Math.max(0, Math.min(100, (1 - idle / total) * 100));
}

export function readSystemMetrics({
    statPath = '/proc/stat',
    memPath = '/proc/meminfo',
    previous = null,
    nowMs = Date.now(),
} = {}) {
    try {
        const read = path => {
            const result = GLib.file_get_contents(path);
            if (!result[0])
                throw new Error(`Cannot read ${path}`);
            return new TextDecoder().decode(result[1]);
        };
        const cpu = parseCpuStat(read(statPath));
        const memory = parseMeminfo(read(memPath));
        return {
            cpuPercent: cpuPercentFromSamples(previous, cpu),
            cpu,
            memory,
            sampledAtMs: nowMs,
        };
    } catch (_) {
        return null;
    }
}
