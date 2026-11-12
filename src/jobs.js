import GLib from 'gi://GLib';
import {canonicalPath, deepClone, mergeDeep, nowIso, pathsOverlap, toNumber, uniqueId} from './util.js';

export const JOB_TYPES = {
    SYNC: 'sync',
    BACKUP: 'backup',
};

export const TRIGGER_MODES = {
    REALTIME: 'realtime',
    INTERVAL: 'interval',
    MANUAL: 'manual',
};

export const JOB_STATUS = {
    IDLE: 'idle',
    RUNNING: 'running',
    PAUSED: 'paused',
    WAITING_SOURCE: 'waiting-source',
    WAITING_DESTINATION: 'waiting-destination',
    OFFLINE: 'offline',
    ERROR: 'error',
    NEEDS_AUTH: 'needs-auth',
    DISABLED: 'disabled',
};

export function defaultJob(input = {}) {
    const base = {
        id: uniqueId('job_'),
        name: '',
        type: JOB_TYPES.SYNC,
        enabled: true,
        source: {kind: 'local', path: ''},
        destination: {kind: 'local', path: ''},
        trigger: {mode: TRIGGER_MODES.REALTIME},
        filters: {exclude: []},
        options: {
            maxDeletePercent: 10,
            maxDeleteMinimum: 10,
            bandwidthLimit: '',
            transfers: 4,
            checkers: 8,
            preserveMetadata: false,
            followSymlinks: false,
        },
        backup: {retentionDays: 30},
        createdAt: nowIso(),
        updatedAt: nowIso(),
    };
    return mergeDeep(base, input);
}

export function normalizeJob(input) {
    const job = defaultJob(input);
    job.id = input.id || job.id;
    job.type = Object.values(JOB_TYPES).includes(job.type) ? job.type : JOB_TYPES.SYNC;
    job.trigger.mode = Object.values(TRIGGER_MODES).includes(job.trigger.mode)
        ? job.trigger.mode
        : TRIGGER_MODES.REALTIME;
    job.filters.exclude = Array.isArray(job.filters.exclude) ? job.filters.exclude : [];
    job.options.maxDeletePercent = toNumber(job.options.maxDeletePercent, 10);
    job.options.maxDeleteMinimum = toNumber(job.options.maxDeleteMinimum, 10);
    job.options.transfers = toNumber(job.options.transfers, 4);
    job.options.checkers = toNumber(job.options.checkers, 8);
    job.backup.retentionDays = toNumber(job.backup.retentionDays, 30);
    job.enabled = Boolean(job.enabled);
    return job;
}

export function isLocalDescriptor(descriptor) {
    return descriptor?.kind === 'local';
}

export function isRemoteDescriptor(descriptor) {
    return descriptor?.kind === 'remote';
}

export function descriptorToString(descriptor) {
    if (!descriptor)
        return '';
    if (descriptor.kind === 'remote')
        return descriptor.path ? `${descriptor.remote}:${descriptor.path}` : `${descriptor.remote}:`;
    return descriptor.path || '';
}

export function descriptorKey(descriptor) {
    if (!descriptor)
        return '';
    if (descriptor.kind === 'remote') {
        const path = String(descriptor.path || '')
            .replace(/^\/+|\/+$/g, '');
        return `remote:${descriptor.remote}:${path}`;
    }
    if (descriptor.volumeUuid)
        return `volume:${descriptor.volumeUuid}:${descriptor.relativePath || ''}`;
    return `local:${canonicalPath(descriptor.path || '')}`;
}

export function descriptorDisplay(descriptor, volumes = null) {
    if (!descriptor)
        return '';
    if (descriptor.kind === 'remote')
        return descriptorToString(descriptor);
    if (descriptor.volumeUuid && volumes) {
        const name = volumes.volumeName(descriptor.volumeUuid) || descriptor.volumeUuid;
        return `${name}:${descriptor.relativePath || '/'}`;
    }
    return descriptor.path || '';
}

export function descriptorFromString(text, {remotes = [], volumes = null} = {}) {
    const value = String(text || '').trim();
    if (value.startsWith('local:')) {
        const path = value.slice('local:'.length);
        return volumes ? volumes.makeDescriptor(path) : {kind: 'local', path};
    }
    const colon = value.indexOf(':');
    if (colon > 0) {
        const remote = value.slice(0, colon);
        if (remotes.includes(remote)) {
            return {
                kind: 'remote',
                remote,
                path: value.slice(colon + 1).replace(/^\/+/, ''),
            };
        }
    }
    return volumes ? volumes.makeDescriptor(value) : {kind: 'local', path: value};
}

export function localPathFor(descriptor, volumes) {
    if (!isLocalDescriptor(descriptor))
        return null;
    if (volumes) {
        try {
            return volumes.resolve(descriptor);
        } catch (_) {
            // Fall through to the last known path.
        }
    }
    return descriptor.path || null;
}

export function remotePathFor(descriptor) {
    if (!isRemoteDescriptor(descriptor))
        return null;
    return descriptor.path ? `${descriptor.remote}:${descriptor.path}` : `${descriptor.remote}:`;
}

function remotePathsOverlap(a, b) {
    if (a.remote !== b.remote)
        return false;
    const normalize = value => String(value || '').replace(/^\/+|\/+$/g, '');
    const pa = normalize(a.path);
    const pb = normalize(b.path);
    if (pa === pb)
        return true;
    if (pa === '')
        return true;
    if (pb === '')
        return true;
    return pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`);
}

export function validateJob(job, {remotes = [], volumes = null, checkPaths = false} = {}) {
    const errors = [];
    if (!job || typeof job !== 'object')
        return ['Job inválido.'];
    if (!job.name || !String(job.name).trim())
        errors.push('O nome do job é obrigatório.');
    if (!Object.values(JOB_TYPES).includes(job.type))
        errors.push('O tipo deve ser "sync" ou "backup".');

    for (const [label, descriptor] of [['origem', job.source], ['destino', job.destination]]) {
        if (!descriptor || !['local', 'remote'].includes(descriptor.kind)) {
            errors.push(`A ${label} é inválida.`);
            continue;
        }
        if (descriptor.kind === 'local') {
            if (!descriptor.path && !descriptor.volumeUuid)
                errors.push(`A ${label} local precisa de um caminho.`);
            if (descriptor.volumeUuid && typeof descriptor.relativePath !== 'string')
                errors.push(`A ${label} local precisa de um caminho relativo ao volume.`);
            if (checkPaths && descriptor.path &&
                !descriptor.volumeUuid &&
                !GLib.file_test(descriptor.path, GLib.FileTest.EXISTS)) {
                errors.push(`A ${label} não existe: ${descriptor.path}`);
            }
        } else {
            if (!descriptor.remote)
                errors.push(`A ${label} remota precisa de um remote.`);
            else if (remotes.length > 0 && !remotes.includes(descriptor.remote))
                errors.push(`Remote desconhecido na ${label}: ${descriptor.remote}`);
        }
    }

    if (job.source?.kind === 'local' && job.destination?.kind === 'local') {
        const sourcePath = localPathFor(job.source, volumes);
        const destPath = localPathFor(job.destination, volumes);
        if (sourcePath && destPath && pathsOverlap(sourcePath, destPath))
            errors.push('Origem e destino não podem ser iguais nem um dentro do outro.');
    } else if (job.source?.kind === 'remote' && job.destination?.kind === 'remote') {
        if (remotePathsOverlap(job.source, job.destination))
            errors.push('Origem e destino remotos não podem apontar para o mesmo caminho.');
    }

    if (!Object.values(TRIGGER_MODES).includes(job.trigger?.mode))
        errors.push('O modo de agendamento é inválido.');
    if (job.trigger?.mode === TRIGGER_MODES.INTERVAL &&
        toNumber(job.trigger.intervalMinutes, 0) <= 0)
        errors.push('O intervalo precisa ser maior que zero.');

    const maxDelete = toNumber(job.options?.maxDeletePercent, 10);
    if (maxDelete < 0 || maxDelete > 100)
        errors.push('O limite de exclusão deve estar entre 0 e 100%.');
    if (toNumber(job.options?.maxDeleteMinimum, 10) < 0)
        errors.push('O mínimo absoluto de exclusões não pode ser negativo.');
    if (toNumber(job.options?.transfers, 4) <= 0)
        errors.push('O número de transferências precisa ser maior que zero.');
    if (toNumber(job.options?.checkers, 8) <= 0)
        errors.push('O número de checkers precisa ser maior que zero.');
    if (toNumber(job.backup?.retentionDays, 30) < 0)
        errors.push('A retenção de versões não pode ser negativa.');

    return errors;
}

export function jobRemoteNames(job) {
    const names = new Set();
    if (job.source?.kind === 'remote')
        names.add(job.source.remote);
    if (job.destination?.kind === 'remote')
        names.add(job.destination.remote);
    return [...names];
}

export function jobSourceLabel(job, volumes = null) {
    return descriptorDisplay(job.source, volumes);
}

export function jobDestinationLabel(job, volumes = null) {
    return descriptorDisplay(job.destination, volumes);
}

export function cloneJob(job) {
    return deepClone(job);
}
