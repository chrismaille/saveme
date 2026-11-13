import {JOB_TYPES} from '../domain/job.js';

export class RunCoordinator {
    constructor({sync, backup}) {
        this.sync = sync;
        this.backup = backup;
    }

    serviceFor(job) {
        return job.type === JOB_TYPES.BACKUP ? this.backup : this.sync;
    }

    runFull(job, options = {}) {
        return this.serviceFor(job).runFull(job, options);
    }

    runIncremental(job, changes, options = {}) {
        return this.serviceFor(job).runIncremental(job, changes, options);
    }
}
