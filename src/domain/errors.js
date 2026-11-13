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
