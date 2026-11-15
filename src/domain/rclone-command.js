import {normalizeIncludes} from './include-filter.js';

export const DEFAULT_EXCLUDES = [
    '.saveme/**',
    '.saveme-versions/**',
    '.Trash-*/**',
    '.DS_Store',
    'Thumbs.db',
    'desktop.ini',
    '*.tmp',
    '*.partial',
    '~$*',
];

export function escapeFilterPath(path) {
    return String(path)
        .replace(/\\/g, '\\\\')
        .replace(/\*/g, '\\*')
        .replace(/\?/g, '\\?')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]');
}

export function filterRules(job, {includeSelection = true} = {}) {
    const all = [...DEFAULT_EXCLUDES, ...(job.filters?.exclude ?? [])];
    const rules = [];
    for (const raw of all) {
        const value = String(raw).trim();
        if (!value || value.startsWith('#'))
            continue;
        if (value.startsWith('- ') || value.startsWith('+ '))
            rules.push(value);
        else
            rules.push(`- ${value}`);
    }
    const includes = includeSelection && job.type === 'sync'
        ? normalizeIncludes(job.filters?.include)
        : [];
    if (includes.length > 0) {
        for (const item of includes) {
            const escaped = escapeFilterPath(item);
            rules.push(`+ /${escaped}`);
            rules.push(`+ /${escaped}/**`);
        }
        rules.push('- **');
    }
    return [...new Set(rules)];
}

export function commonJobArgs(job, filterFile, options = {}) {
    const copy = options.copy === undefined ? true : options.copy;
    const args = [
        '--filter-from', filterFile,
        '--transfers', String(job.options?.transfers || 4),
        '--checkers', String(job.options?.checkers || 8),
    ];
    if (copy)
        args.push('--create-empty-src-dirs');
    if (job.options?.preserveMetadata)
        args.push('--metadata');
    if (job.options?.followSymlinks)
        args.push('--copy-links');
    if (job.options?.bandwidthLimit)
        args.push('--bwlimit', String(job.options.bandwidthLimit));
    return args;
}

export function syncArgs(source, dest, filterFile, job, options = {}) {
    return ['sync', source, dest, ...commonJobArgs(job, filterFile, options)];
}

export function backupArgs(source, current, versionDir, filterFile, job, options = {}) {
    return ['sync', source, current, ...commonJobArgs(job, filterFile, options),
        '--backup-dir', versionDir];
}

export function copyArgs(source, dest, filterFile, job, options = {}) {
    const backupDir = options.backupDir === undefined ? null : options.backupDir;
    const noTraverse = options.noTraverse === undefined ? false : options.noTraverse;
    const copy = options.copy === undefined ? true : options.copy;
    const args = ['copy', source, dest];
    if (noTraverse)
        args.push('--no-traverse');
    args.push.apply(args, commonJobArgs(job, filterFile, {copy}));
    if (backupDir)
        args.push('--backup-dir', backupDir);
    return args;
}

export function moveArgs(source, dest, filterFile, job, options = {}) {
    const noTraverse = options.noTraverse === undefined ? false : options.noTraverse;
    const copy = options.copy === undefined ? false : options.copy;
    const args = ['move', source, dest];
    if (noTraverse)
        args.push('--no-traverse');
    args.push.apply(args, commonJobArgs(job, filterFile, {copy}));
    return args;
}

export function deleteArgs(dest, filterFile, job) {
    return ['delete', dest, ...commonJobArgs(job, filterFile, {copy: false})];
}

export function rmdirsArgs(dest, filterFile, job) {
    return ['rmdirs', dest, '--leave-root', ...commonJobArgs(job, filterFile, {copy: false})];
}

export function withDryRun(args) {
    return [...args, '--dry-run'];
}

export function withFastList(args) {
    return [...args, '--fast-list'];
}

export function withMaxDelete(args, limit) {
    return [...args, '--max-delete', String(limit)];
}
