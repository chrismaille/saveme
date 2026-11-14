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
    jobSources,
    localPathFor,
    normalizeJobFields,
    remotePathFor,
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
    jobSources,
    localPathFor,
    remotePathFor,
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

export function validateJob(job, {remotes = [], volumes = null, checkPaths = false} = {}) {
    if (job?.draft)
        return [];
    const errors = validateJobFields(job, {remotes});
    if (!job || typeof job !== 'object')
        return errors;

    for (const [label, descriptor] of [
        ...jobSources(job).map((source, index) => [
            jobSources(job).length > 1 ? `origem ${index + 1}` : 'origem',
            source,
        ]),
        ['destino', job.destination],
    ]) {
        if (descriptor?.kind === 'local' && checkPaths && descriptor.path &&
            !descriptor.volumeUuid &&
            !GLib.file_test(descriptor.path, GLib.FileTest.EXISTS)) {
            errors.push(`A ${label} não existe: ${descriptor.path}`);
        }
    }

    if (job.destination?.kind === 'local') {
        const destPath = localPathFor(job.destination, volumes);
        for (const [index, source] of jobSources(job).entries()) {
            if (source?.kind !== 'local')
                continue;
            const sourcePath = localPathFor(source, volumes);
            if (sourcePath && destPath && pathsOverlap(sourcePath, destPath)) {
                const label = jobSources(job).length > 1 ? `origem ${index + 1}` : 'origem';
                errors.push(`${label} e destino não podem ser iguais nem um dentro do outro.`);
            }
        }
    }

    return errors;
}
