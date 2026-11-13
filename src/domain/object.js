export function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}

export function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function mergeDeep(base, override) {
    const result = deepClone(base);
    if (!isPlainObject(override))
        return result;
    for (const key of Object.keys(override)) {
        const value = override[key];
        if (isPlainObject(value) && isPlainObject(result[key]))
            result[key] = mergeDeep(result[key], value);
        else
            result[key] = deepClone(value);
    }
    return result;
}

export function toNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}
