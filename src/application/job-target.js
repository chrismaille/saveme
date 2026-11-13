import {
    isLocalDescriptor,
    localPathFor,
    remotePathFor,
} from '../domain/job.js';
import {SourceUnavailableError} from '../domain/errors.js';

export function resolveJobTargets(job, {files, volumes}) {
    const source = isLocalDescriptor(job.source)
        ? localPathFor(job.source, volumes)
        : remotePathFor(job.source);
    const dest = isLocalDescriptor(job.destination)
        ? localPathFor(job.destination, volumes)
        : remotePathFor(job.destination);
    if (!source || !dest)
        throw new Error('Source and destination are required.');

    const sourceIsLocal = isLocalDescriptor(job.source);
    const destIsLocal = isLocalDescriptor(job.destination);

    if (sourceIsLocal) {
        if (!files.exists(source))
            throw new SourceUnavailableError(`Source does not exist: ${source}`);
        if (!files.isDirectory(source))
            throw new Error(`Source is not a directory: ${source}`);
    }

    if (destIsLocal && files.exists(dest) && !files.isDirectory(dest))
        throw new Error(`Destination is not a directory: ${dest}`);

    return {source, dest, sourceIsLocal, destIsLocal};
}
