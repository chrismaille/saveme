import {jobDefaults, normalizeJobFields} from './job.js';
import {mergeDeep} from './object.js';

export const BACKUP_MANIFEST_FILE = 'manifest.json';
export const BACKUP_MANIFEST_VERSION = 1;

export function serializeBackupManifest(job, {createdAt = job.createdAt, updatedAt = job.updatedAt} = {}) {
    return `${JSON.stringify({
        version: BACKUP_MANIFEST_VERSION,
        job: {
            id: job.id,
            name: job.name,
            type: job.type,
            sources: job.sources?.length ? job.sources : [job.source].filter(Boolean),
            destination: job.destination,
            trigger: job.trigger,
            filters: job.filters,
            options: job.options,
            backup: job.backup,
            createdAt,
            updatedAt,
        },
    }, null, 2)}\n`;
}

export function parseBackupManifest(text) {
    let data;
    try {
        data = JSON.parse(String(text || ''));
    } catch (e) {
        throw new Error(`Invalid backup manifest: ${e.message}`, {cause: e});
    }
    if (!data || data.version !== BACKUP_MANIFEST_VERSION ||
        !data.job || typeof data.job !== 'object') {
        throw new Error('Unsupported backup manifest.');
    }
    const job = normalizeJobFields(mergeDeep(jobDefaults(), data.job));
    if (!job.id || job.type !== 'backup')
        throw new Error('Backup manifest does not describe a backup job.');
    return job;
}
