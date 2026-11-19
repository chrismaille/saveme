export class SourceUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SourceUnavailableError';
    }
}

export class DestinationUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = 'DestinationUnavailableError';
    }
}

export class EmptySourceError extends Error {
    constructor(lastCount) {
        super(`Source is empty but the last run saw ${lastCount} files. Aborting to prevent data loss.`);
        this.name = 'EmptySourceError';
        this.lastCount = lastCount;
    }
}

export class SourceChangedError extends Error {
    constructor(current, previous) {
        super(`Source changed: ${current} file(s) now, ` +
            `the last successful backup saw ${previous}. ` +
            'The run was stopped before deleting the existing copy.');
        this.name = 'SourceChangedError';
        this.current = current;
        this.previous = previous;
    }
}

export class DeleteGuardError extends Error {
    constructor(deletes, allowed, total, percent) {
        super(`Delete guard: ${deletes} file(s) would be deleted, ` +
            `limit is ${allowed} (${percent}% of ${total}). Use force to override.`);
        this.name = 'DeleteGuardError';
        this.deletes = deletes;
        this.allowed = allowed;
        this.total = total;
        this.percent = percent;
    }
}

export class VolumeUnavailableError extends Error {
    constructor(descriptor) {
        super(`Volume not mounted: ${descriptor.volumeUuid || descriptor.path}`);
        this.name = 'VolumeUnavailableError';
        this.descriptor = descriptor;
    }
}

export class DiskSpaceError extends Error {
    constructor({freeBytes, requiredBytes, destination}) {
        super(`Not enough free disk space at ${destination}: ` +
            `${formatBytes(freeBytes)} free, ${formatBytes(requiredBytes)} required.`);
        this.name = 'DiskSpaceError';
        this.freeBytes = freeBytes;
        this.requiredBytes = requiredBytes;
        this.destination = destination;
    }
}

function formatBytes(value) {
    let n = Number(value) || 0;
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let unit = 0;
    while (n >= 1024 && unit < units.length - 1) {
        n /= 1024;
        unit++;
    }
    return `${n.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
