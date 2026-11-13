export {
    DeleteGuardError,
    DestinationUnavailableError,
    EmptySourceError,
    SourceUnavailableError,
} from './domain/errors.js';
export {
    backupCurrentFor,
    backupRootFor,
    joinRclonePath,
    versionsRootFor,
} from './domain/backup-layout.js';
export {parseVersionTimestamp} from './domain/time.js';
export {
    commonJobArgs,
    escapeFilterPath,
    filterRules,
} from './domain/rclone-command.js';

export class JobRunner {
    constructor({coordinator, volumes}) {
        this.coordinator = coordinator;
        this.volumes = volumes;
    }

    runFull(job, options = {}) {
        return this.coordinator.runFull(job, options);
    }

    runIncremental(job, changes, options = {}) {
        return this.coordinator.runIncremental(job, changes, options);
    }
}
