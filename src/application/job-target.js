import {
    isLocalDescriptor,
    jobSources,
    localPathFor,
    remotePathFor,
} from '../domain/job.js';
import {sourceFolderName} from '../domain/backup-layout.js';
import {SourceUnavailableError} from '../domain/errors.js';

export function resolveJobTargets(job, {files, volumes}) {
    const sources = jobSources(job).map((descriptor, index) => {
        const path = isLocalDescriptor(descriptor)
            ? localPathFor(descriptor, volumes)
            : remotePathFor(descriptor);
        const isLocal = isLocalDescriptor(descriptor);
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
    const dest = isLocalDescriptor(job.destination)
        ? localPathFor(job.destination, volumes)
        : remotePathFor(job.destination);
    if (sources.length === 0 || !dest)
        throw new Error('Source and destination are required.');

    const destIsLocal = isLocalDescriptor(job.destination);
    if (destIsLocal && files.exists(dest) && !files.isDirectory(dest))
        throw new Error(`Destination is not a directory: ${dest}`);

    return {
        source: sources[0].path,
        sourceIsLocal: sources[0].isLocal,
        dest,
        destIsLocal,
        sources,
    };
}
