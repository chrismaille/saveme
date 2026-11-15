export function normalizeIncludePath(value) {
    let text = String(value || '').trim().replace(/\\/g, '/');
    text = text.replace(/^\.\/+/, '').replace(/^\/+|\/+$/g, '');
    if (!text || text.includes('\n') || text.includes('\r'))
        return '';
    if (text.split('/').some(part => part === '..'))
        return '';
    return text;
}

export function normalizeIncludes(values) {
    if (!Array.isArray(values))
        return [];
    return [...new Set(values.map(normalizeIncludePath).filter(Boolean))];
}

/**
 * True when a relative source path is inside the sync include selection.
 * An empty selection means the whole source, and non-sync jobs ignore it.
 */
export function isPathIncluded(job, relativePath) {
    if (job?.type !== 'sync')
        return true;
    const includes = normalizeIncludes(job.filters?.include);
    if (includes.length === 0)
        return true;
    const path = normalizeIncludePath(relativePath);
    if (!path)
        return false;
    return includes.some(item =>
        path === item || path.startsWith(`${item}/`));
}
