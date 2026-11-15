import {deepClone, mergeDeep, toNumber} from './object.js';
import {isValidTime} from './schedule.js';
import {normalizeIncludes} from './include-filter.js';

export const JOB_TYPES = {
    SYNC: 'sync',
    BACKUP: 'backup',
};

export const TRIGGER_MODES = {
    REALTIME: 'realtime',
    INTERVAL: 'interval',
    WEEKLY: 'weekly',
    MONTHLY: 'monthly',
    STARTUP: 'startup',
    DUSK: 'dusk',
    MANUAL: 'manual',
};

export function jobDefaults(input = {}, {
    idFactory = () => '',
    now = () => '',
} = {}) {
    const base = {
        id: idFactory(),
        name: '',
        type: JOB_TYPES.SYNC,
        enabled: true,
        source: {kind: 'local', path: ''},
        sources: [],
        destination: {kind: 'local', path: ''},
        destinationLayout: 'saveMe',
        trigger: {
            mode: TRIGGER_MODES.REALTIME,
            intervalMinutes: 60,
            intervalValue: 1,
            intervalUnit: 'hours',
            dayOfWeek: 1,
            dayOfMonth: 1,
            time: '18:00',
            idleOnly: false,
        },
        filters: {exclude: [], include: []},
        options: {
            maxDeletePercent: 10,
            maxDeleteMinimum: 10,
            bandwidthLimit: '',
            transfers: 4,
            checkers: 8,
            preserveMetadata: false,
            followSymlinks: false,
            notifyOnComplete: true,
        },
        backup: {retentionDays: 30, keepForever: false},
        draft: false,
        draftStep: 0,
        createdAt: now(),
        updatedAt: now(),
    };
    return mergeDeep(base, input);
}

export function normalizeJobFields(job) {
    job.id = job.id || '';
    job.type = Object.values(JOB_TYPES).includes(job.type) ? job.type : JOB_TYPES.SYNC;
    job.destinationLayout = job.type === JOB_TYPES.BACKUP
        ? 'saveMe'
        : job.destinationLayout === 'direct' ? 'direct' : 'saveMe';
    const sources = Array.isArray(job.sources) ? job.sources.filter(Boolean) : [];
    if (sources.length === 0 && job.source)
        sources.push(job.source);
    job.sources = sources;
    job.source = sources[0] || job.source;
    job.trigger.mode = Object.values(TRIGGER_MODES).includes(job.trigger.mode)
        ? job.trigger.mode
        : TRIGGER_MODES.REALTIME;
    job.trigger.intervalMinutes = Math.max(1, toNumber(job.trigger.intervalMinutes, 60));
    job.trigger.intervalValue = Math.max(1, toNumber(job.trigger.intervalValue, 1));
    job.trigger.intervalUnit = ['minutes', 'hours', 'days'].includes(job.trigger.intervalUnit)
        ? job.trigger.intervalUnit : 'hours';
    // Jobs saved before interval units existed only have intervalMinutes.
    if (job.trigger.intervalMinutes !== 60 && job.trigger.intervalValue === 1 &&
        job.trigger.intervalUnit === 'hours') {
        const minutes = job.trigger.intervalMinutes;
        if (minutes % 1440 === 0) {
            job.trigger.intervalValue = minutes / 1440;
            job.trigger.intervalUnit = 'days';
        } else if (minutes % 60 === 0) {
            job.trigger.intervalValue = minutes / 60;
            job.trigger.intervalUnit = 'hours';
        } else {
            job.trigger.intervalValue = minutes;
            job.trigger.intervalUnit = 'minutes';
        }
    }
    // Old backup jobs could use realtime mode. Backups no longer support a
    // watcher, so migrate them to a safe hourly schedule on load.
    if (job.type === JOB_TYPES.BACKUP && job.trigger.mode === TRIGGER_MODES.REALTIME) {
        job.trigger.mode = TRIGGER_MODES.INTERVAL;
        job.trigger.intervalMinutes = 60;
        job.trigger.intervalValue = 1;
        job.trigger.intervalUnit = 'hours';
    }
    job.trigger.dayOfWeek = Math.max(0, Math.min(6, toNumber(job.trigger.dayOfWeek, 1)));
    job.trigger.dayOfMonth = Math.max(1, Math.min(31, toNumber(job.trigger.dayOfMonth, 1)));
    job.trigger.time = isValidTime(job.trigger.time)
        ? job.trigger.time : '18:00';
    job.trigger.idleOnly = Boolean(job.trigger.idleOnly);
    job.filters.exclude = Array.isArray(job.filters.exclude) ? job.filters.exclude : [];
    job.filters.include = normalizeIncludes(job.filters.include);
    job.options.maxDeletePercent = toNumber(job.options.maxDeletePercent, 10);
    job.options.maxDeleteMinimum = toNumber(job.options.maxDeleteMinimum, 10);
    job.options.transfers = toNumber(job.options.transfers, 4);
    job.options.checkers = toNumber(job.options.checkers, 8);
    job.options.notifyOnComplete = job.options.notifyOnComplete !== false;
    job.backup.retentionDays = toNumber(job.backup.retentionDays, 30);
    // retentionDays = 0 was the old "keep forever" spelling.
    job.backup.keepForever = Boolean(job.backup.keepForever || job.backup.retentionDays === 0);
    job.draft = Boolean(job.draft);
    job.draftStep = Math.max(0, Math.min(4, toNumber(job.draftStep, 0)));
    job.enabled = Boolean(job.enabled);
    return job;
}

export function jobSources(job) {
    if (!job)
        return [];
    if (Array.isArray(job.sources) && job.sources.length > 0)
        return job.sources.filter(Boolean);
    return job.source ? [job.source] : [];
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

export function descriptorKey(descriptor, {canonicalize = value => value} = {}) {
    if (!descriptor)
        return '';
    if (descriptor.kind === 'remote') {
        const path = String(descriptor.path || '')
            .replace(/^\/+|\/+$/g, '');
        return `remote:${descriptor.remote}:${path}`;
    }
    if (descriptor.volumeUuid)
        return `volume:${descriptor.volumeUuid}:${descriptor.relativePath || ''}`;
    return `local:${canonicalize(descriptor.path || '')}`;
}

export function descriptorDisplay(descriptor, {volumeName = null} = {}) {
    if (!descriptor)
        return '';
    if (descriptor.kind === 'remote')
        return descriptorToString(descriptor);
    if (descriptor.volumeUuid && volumeName) {
        const name = volumeName(descriptor.volumeUuid) || descriptor.volumeUuid;
        return `${name}:${descriptor.relativePath || '/'}`;
    }
    return descriptor.path || '';
}

export function descriptorFromString(text, {
    remotes = [],
    makeLocal = null,
} = {}) {
    const value = String(text || '').trim();
    if (value.startsWith('local:')) {
        const path = value.slice('local:'.length);
        return makeLocal ? makeLocal(path) : {kind: 'local', path};
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
    return makeLocal ? makeLocal(value) : {kind: 'local', path: value};
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

export function remotePathsOverlap(a, b) {
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

export function validateJobFields(job, {remotes = []} = {}) {
    const errors = [];
    if (!job || typeof job !== 'object')
        return ['Job inválido.'];
    if (job.draft)
        return [];
    if (!job.name || !String(job.name).trim())
        errors.push('O nome do job é obrigatório.');
    if (!Object.values(JOB_TYPES).includes(job.type))
        errors.push('O tipo deve ser "sync" ou "backup".');

    const sources = jobSources(job);
    if (sources.length === 0)
        errors.push('A origem é obrigatória.');
    if (job.type === JOB_TYPES.SYNC && sources.length > 1)
        errors.push('Sync jobs have exactly one source. Use Backup for multiple sources.');
    if (job.type === JOB_TYPES.BACKUP && job.trigger?.mode === TRIGGER_MODES.REALTIME)
        errors.push('Backup jobs cannot use real-time mode.');

    const descriptors = [
        ...sources.map((descriptor, index) => ({
            label: sources.length > 1 ? `origem ${index + 1}` : 'origem',
            descriptor,
        })),
        {label: 'destino', descriptor: job.destination},
    ];
    for (const item of descriptors) {
        const label = item.label;
        const descriptor = item.descriptor;
        if (!descriptor || !['local', 'remote'].includes(descriptor.kind)) {
            errors.push(`A ${label} é inválida.`);
            continue;
        }
        if (descriptor.kind === 'local') {
            if (!descriptor.path && !descriptor.volumeUuid)
                errors.push(`A ${label} local precisa de um caminho.`);
            if (descriptor.volumeUuid && typeof descriptor.relativePath !== 'string')
                errors.push(`A ${label} local precisa de um caminho relativo ao volume.`);
        } else {
            if (!descriptor.remote)
                errors.push(`A ${label} remota precisa de um remote.`);
            else if (remotes.length > 0 && !remotes.includes(descriptor.remote) && !job.recovered)
                errors.push(`Remote desconhecido na ${label}: ${descriptor.remote}`);
        }
    }

    const sourceKeys = new Set();
    for (const source of sources) {
        const key = descriptorKey(source);
        if (key && sourceKeys.has(key))
            errors.push('As origens não podem ser duplicadas.');
        sourceKeys.add(key);
    }

    for (const source of sources) {
        if (source?.kind === 'remote' && job.destination?.kind === 'remote') {
            if (remotePathsOverlap(source, job.destination))
                errors.push('Origem e destino remotos não podem apontar para o mesmo caminho.');
        }
    }

    if (!Object.values(TRIGGER_MODES).includes(job.trigger?.mode))
        errors.push('O modo de agendamento é inválido.');
    if (job.trigger?.mode === TRIGGER_MODES.INTERVAL &&
        toNumber(job.trigger.intervalMinutes, 0) <= 0)
        errors.push('O intervalo precisa ser maior que zero.');
    if ([TRIGGER_MODES.WEEKLY, TRIGGER_MODES.MONTHLY, TRIGGER_MODES.DUSK]
        .includes(job.trigger?.mode) && !isValidTime(job.trigger.time))
        errors.push('O horário do agendamento é inválido.');
    if (job.trigger?.mode === TRIGGER_MODES.MONTHLY &&
        (toNumber(job.trigger.dayOfMonth, 0) < 1 || toNumber(job.trigger.dayOfMonth, 0) > 31))
        errors.push('O dia do mês deve ficar entre 1 e 31.');

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
    for (const source of jobSources(job)) {
        if (source?.kind === 'remote')
            names.add(source.remote);
    }
    if (job.destination?.kind === 'remote')
        names.add(job.destination.remote);
    return [...names];
}

export function cloneJob(job) {
    return deepClone(job);
}
