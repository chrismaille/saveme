export const DEFAULT_DISK_GUARD = Object.freeze({
    safetyPercent: 10,
    minimumFreeBytes: 512 * 1024 * 1024,
});

function finiteBytes(value) {
    if (value === null || value === undefined || value === '')
        return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
}

export function planDiskCheck({
    sourceBytes = null,
    freeBytes = null,
    safetyPercent = DEFAULT_DISK_GUARD.safetyPercent,
    minimumFreeBytes = DEFAULT_DISK_GUARD.minimumFreeBytes,
    factor = 1,
} = {}) {
    const source = finiteBytes(sourceBytes);
    const free = finiteBytes(freeBytes);
    if (source === null || free === null)
        return {checked: false, ok: true, sourceBytes: source, freeBytes: free};
    const safety = Math.max(0, Number(safetyPercent) || 0);
    const minimum = Math.max(0, Number(minimumFreeBytes) || 0);
    const multiplier = Math.max(0, Number(factor) || 1);
    const base = Math.ceil(source * multiplier);
    const requiredBytes = base + Math.ceil(base * safety / 100) + minimum;
    return {
        checked: true,
        ok: free >= requiredBytes,
        sourceBytes: source,
        freeBytes: free,
        requiredBytes,
        safetyPercent: safety,
        minimumFreeBytes: minimum,
        factor: multiplier,
    };
}
