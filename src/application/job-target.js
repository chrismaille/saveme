import {
    isLocalDescriptor,
    jobSources,
    localPathFor,
    remotePathFor,
} from '../domain/job.js';
import {sourceFolderName, syncRootFor} from '../domain/backup-layout.js';
import {
    DestinationUnavailableError,
    SourceUnavailableError,
} from '../domain/errors.js';

function localTargetPath(descriptor, volumes, role) {
    if (descriptor?.volumeUuid && typeof volumes?.resolve === 'function') {
        try {
            return volumes.resolve(descriptor);
        } catch (e) {
            if (e.name !== 'VolumeUnavailableError')
                throw e;
            const volume = descriptor.volumeName ||
                e.descriptor?.volumeName ||
                descriptor.volumeUuid;
            const message = role === 'source'
                ? `Source disk is unavailable: ${volume}`
                : `Destination disk is unavailable: ${volume}`;
            if (role === 'source')
                throw new SourceUnavailableError(message);
            throw new DestinationUnavailableError(message);
        }
    }
    return localPathFor(descriptor, volumes);
}

export function resolveJobTargets(job, {files, volumes}) {
    const sources = jobSources(job).map((descriptor, index) => {
        const isLocal = isLocalDescriptor(descriptor);
        const path = isLocal
            ? localTargetPath(descriptor, volumes, 'source')
            : remotePathFor(descriptor);
        if (!path)
            throw new Error('Source and destination are required.');
        if (isLocal) {
            if (!files.exists(path))
                throw new SourceUnavailableError(`Source does not exist: ${path}`);
            if (!files.isDirectory(path))
                throw new Error(`Source is not a directory: ${path}`);
        }
        return {
            descriptor,
            path,
            isLocal,
            label: sourceFolderName(descriptor, index),
        };
    });
    const destBase = isLocalDescriptor(job.destination)
        ? localTargetPath(job.destination, volumes, 'destination')
        : remotePathFor(job.destination);
    if (sources.length === 0 || !destBase)
        throw new Error('Source and destination are required.');
    const dest = job.type === 'sync' ? syncRootFor(job, destBase) : destBase;

    const destIsLocal = isLocalDescriptor(job.destination);
    if (destIsLocal && files.exists(dest) && !files.isDirectory(dest))
        throw new Error(`Destination is not a directory: ${dest}`);

    return {
        source: sources[0].path,
        sourceIsLocal: sources[0].isLocal,
        dest,
        destBase,
        destIsLocal,
        sources,
    };
}
