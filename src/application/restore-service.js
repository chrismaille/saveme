import {
    backupCurrentFor,
    isSafeRelativePath,
    isValidVersionName,
    versionsRootFor,
} from '../domain/backup-layout.js';
import {JOB_TYPES} from '../domain/job.js';
import {exitCodeMessage, isSuccessExit} from '../domain/rclone-log.js';

export class RestoreService {
    constructor({transfer}) {
        this.transfer = transfer;
    }

    restore({job, destination, payload}) {
        if (!job)
            throw new Error('Job not found.');
        if (!payload.target)
            throw new Error('Restore target is required.');
        if (!isSafeRelativePath(payload.target) || !isSafeRelativePath(payload.path || ''))
            throw new Error('Invalid restore path.');

        let source;
        if (payload.version) {
            if (!isValidVersionName(payload.version))
                throw new Error('Invalid version name.');
            source = `${versionsRootFor(job, destination)}/${payload.version}`;
        } else {
            source = job.type === JOB_TYPES.BACKUP
                ? backupCurrentFor(job, destination)
                : destination;
        }
        if (payload.path) {
            source = `${String(source).replace(/\/+$/, '')}/` +
                `${String(payload.path).replace(/^\/+/, '')}`;
        }

        const args = ['copy', source, payload.target, '--create-empty-src-dirs'];
        if (payload.dryRun)
            args.push('--dry-run');
        const result = this.transfer.runCapture(args);
        if (!isSuccessExit(result.exitCode)) {
            throw new Error(result.stderr.trim() ||
                `Restore failed: ${exitCodeMessage(result.exitCode)}`);
        }
        return {
            ok: true,
            dryRun: Boolean(payload.dryRun),
            source,
        };
    }
}
