import {
    backupCurrentFor,
    joinRclonePath,
} from '../domain/backup-layout.js';
import {exitCodeMessage, isSuccessExit} from '../domain/rclone-log.js';
import {
    backupArgs,
    copyArgs,
    moveArgs,
    rmdirsArgs,
    withDryRun,
    withFastList,
} from '../domain/rclone-command.js';
import {planChanges} from './change-planner.js';
import {resolveJobTargets} from './job-target.js';

export class BackupService {
    constructor({executor, files, volumes}) {
        this.executor = executor;
        this.files = files;
        this.volumes = volumes;
    }

    async runFull(job, {
        dryRun = false,
        force = false,
        reason = 'manual',
        cancellable = null,
        onProgress = null,
        runId = null,
    } = {}) {
        const ctx = this.executor.beginRun(job, {
            dryRun,
            reason,
            incremental: false,
            runId,
        });
        ctx.onProgress = onProgress;
        try {
            const prep = resolveJobTargets(job, {files: this.files, volumes: this.volumes});
            const sourceCount = await this.executor.sourceCount(job, prep, {
                exact: false,
                cancellable,
            });
            if (Number.isFinite(sourceCount))
                ctx.sourceFileCount = sourceCount;
            this.executor.checkEmptySource(job, sourceCount, force);

            const filterFile = this.executor.filterFile(job);
            const current = backupCurrentFor(job, prep.dest);
            const versionDir = this.executor.versionDir(job, prep.dest, ctx);
            ctx.versionsDir = versionDir;
            let args = backupArgs(prep.source, current, versionDir, filterFile, job);
            if (!prep.sourceIsLocal || !prep.destIsLocal)
                args = withFastList(args);
            if (dryRun)
                args = withDryRun(args);

            const result = await this.executor.runRclone(ctx, args, {
                phase: 'syncing',
                cancellable,
            });
            if (result.cancelled)
                return this.executor.endRun(ctx, 'cancelled', 'Cancelled');
            if (!isSuccessExit(result.exitCode))
                return this.executor.endRun(ctx, 'error',
                    result.lastError || exitCodeMessage(result.exitCode));
            if (!dryRun)
                await this.executor.cleanupVersions(ctx, job, prep.dest, cancellable);
            return this.executor.endRun(ctx, 'success');
        } catch (e) {
            return this.executor.endRun(ctx, 'error', this.executor.friendlyError(e));
        }
    }

    async runIncremental(job, changes, {
        force = false,
        cancellable = null,
        onProgress = null,
        runId = null,
    } = {}) {
        if (changes.length > 500)
            return this.runFull(job, {reason: 'large-batch', force, cancellable, onProgress, runId});

        const ctx = this.executor.beginRun(job, {
            dryRun: false,
            reason: 'realtime',
            incremental: true,
            runId,
        });
        ctx.onProgress = onProgress;
        try {
            const prep = resolveJobTargets(job, {files: this.files, volumes: this.volumes});
            if (!prep.sourceIsLocal)
                throw new Error('Incremental backup requires a local source.');
            const plan = planChanges({
                source: prep.source,
                changes,
                files: this.files,
                logger: ctx.logger,
            });
            const hasUpserts = plan.upserts.length > 0 || plan.dirUpserts.length > 0;
            const hasDeletes = plan.deletes.length > 0 || plan.dirDeletes.length > 0;
            if (!hasUpserts && !hasDeletes)
                return this.executor.endRun(ctx, 'noop', 'No effective changes.');

            const current = backupCurrentFor(job, prep.dest);
            const normalFilter = this.executor.filterFile(job);
            const versionDir = this.executor.versionDir(job, prep.dest, ctx);
            ctx.versionsDir = versionDir;

            for (const rel of plan.dirUpserts) {
                const sourcePath = this.files.joinPath(prep.source, rel);
                const destPath = joinRclonePath(current, rel);
                const args = copyArgs(sourcePath, destPath, normalFilter, job, {
                    backupDir: joinRclonePath(versionDir, rel),
                });
                const step = await this.executor.runStep(ctx, args, {
                    phase: 'syncing',
                    cancellable,
                });
                if (step.run)
                    return step.run;
            }

            if (plan.upserts.length > 0) {
                const includeFilter = this.executor.writeIncludeFilter(ctx, 'upserts', job, {
                    files: plan.upserts,
                });
                const args = copyArgs(prep.source, current, includeFilter, job, {
                    noTraverse: true,
                    backupDir: versionDir,
                });
                const step = await this.executor.runStep(ctx, args, {
                    phase: 'syncing',
                    cancellable,
                });
                if (step.run)
                    return step.run;
            }

            if (hasDeletes) {
                const deleteFilter = this.executor.writeIncludeFilter(ctx, 'backup-deletes', job, {
                    files: plan.deletes,
                    dirs: plan.dirDeletes,
                });
                const moved = await this.executor.runRclone(ctx,
                    moveArgs(current, versionDir, deleteFilter, job, {noTraverse: true}), {
                        phase: 'backing-up',
                        cancellable,
                    });
                if (moved.cancelled)
                    return this.executor.endRun(ctx, 'cancelled', 'Cancelled');
                if (!isSuccessExit(moved.exitCode))
                    ctx.logger.warn('Could not move all deleted files to versions: ' +
                        (moved.lastError || exitCodeMessage(moved.exitCode)));
                const rmdirs = await this.executor.runRclone(ctx,
                    rmdirsArgs(current, deleteFilter, job), {
                        phase: 'backing-up',
                        cancellable,
                    });
                if (!isSuccessExit(rmdirs.exitCode))
                    ctx.logger.warn(`rmdirs: ${rmdirs.lastError || exitCodeMessage(rmdirs.exitCode)}`);
            }

            await this.executor.cleanupVersions(ctx, job, prep.dest, cancellable);

            return this.executor.endRun(ctx, 'success');
        } catch (e) {
            return this.executor.endRun(ctx, 'error', this.executor.friendlyError(e));
        }
    }
}
