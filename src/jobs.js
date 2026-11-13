import GLib from 'gi://GLib';
import {canonicalPath, pathsOverlap, uniqueId, nowIso} from './util.js';
import {
    JOB_TYPES,
    TRIGGER_MODES,
    cloneJob,
    descriptorDisplay as domainDescriptorDisplay,
    descriptorFromString as domainDescriptorFromString,
    descriptorKey as domainDescriptorKey,
    descriptorToString,
    isLocalDescriptor,
    isRemoteDescriptor,
    jobDefaults,
    jobRemoteNames,
    normalizeJobFields,
    validateJobFields,
} from './domain/job.js';

export {
    JOB_TYPES,
    TRIGGER_MODES,
    cloneJob,
    descriptorToString,
    isLocalDescriptor,
    isRemoteDescriptor,
    jobRemoteNames,
};

export function defaultJob(input = {}) {
    return jobDefaults(input, {
        idFactory: () => uniqueId('job_'),
        now: () => nowIso(),
    });
}

export function normalizeJob(input) {
    const job = defaultJob(input);
    return normalizeJobFields(job);
}

export function descriptorKey(descriptor) {
    return domainDescriptorKey(descriptor, {canonicalize: canonicalPath});
}

export function descriptorDisplay(descriptor, volumes = null) {
    return domainDescriptorDisplay(descriptor, {
        volumeName: volumes ? uuid => volumes.volumeName(uuid) : null,
    });
}

export function descriptorFromString(text, {remotes = [], volumes = null} = {}) {
    return domainDescriptorFromString(text, {
        remotes,
        makeLocal: volumes ? path => volumes.makeDescriptor(path) : null,
    });
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

export function validateJob(job, {remotes = [], volumes = null, checkPaths = false} = {}) {
    const errors = validateJobFields(job, {remotes});
    if (!job || typeof job !== 'object')
        return errors;

    for (const [label, descriptor] of [['origem', job.source], ['destino', job.destination]]) {
        if (descriptor?.kind === 'local' && checkPaths && descriptor.path &&
            !descriptor.volumeUuid &&
            !GLib.file_test(descriptor.path, GLib.FileTest.EXISTS)) {
            errors.push(`A ${label} não existe: ${descriptor.path}`);
        }
    }

    if (job.source?.kind === 'local' && job.destination?.kind === 'local') {
        const sourcePath = localPathFor(job.source, volumes);
        const destPath = localPathFor(job.destination, volumes);
        if (sourcePath && destPath && pathsOverlap(sourcePath, destPath))
            errors.push('Origem e destino não podem ser iguais nem um dentro do outro.');
    }

    return errors;
}
