import {joinRclonePath} from '../domain/backup-layout.js';
import {
    assertDeleteAllowed,
    evaluateDeleteGuard,
} from '../domain/delete-guard.js';
import {exitCodeMessage, isSuccessExit} from '../domain/rclone-log.js';
import {
    copyArgs,
    deleteArgs,
    rmdirsArgs,
    syncArgs,
    withDryRun,
    withFastList,
    withMaxDelete,
} from '../domain/rclone-command.js';
import {planChanges} from './change-planner.js';
import {resolveJobTargets} from './job-target.js';

export class SyncService {
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
                exact: true,
                cancellable,
            });
            if (Number.isFinite(sourceCount))
                ctx.sourceFileCount = sourceCount;
            this.executor.checkEmptySource(job, sourceCount, force);

            const filterFile = this.executor.filterFile(job);
            let args = syncArgs(prep.source, prep.dest, filterFile, job);
            let allowedDeletes = null;
            if (!force && !dryRun && Number.isFinite(sourceCount)) {
                allowedDeletes = evaluateDeleteGuard({
                    deletes: 0,
                    total: sourceCount,
                    maxDeletePercent: job.options?.maxDeletePercent ?? 10,
                    maxDeleteMinimum: job.options?.maxDeleteMinimum ?? 10,
                }).allowed;
            }
            if (!prep.sourceIsLocal || !prep.destIsLocal)
                args = withFastList(args);

            if (!force && !dryRun && allowedDeletes !== null) {
                const preflight = await this.executor.runRclone(ctx, withDryRun(args), {
                    phase: 'checking',
                    cancellable,
                    mergeStats: false,
                    quiet: true,
                    trackError: false,
                    trackExitCode: false,
                });
                if (preflight.cancelled)
                    return this.executor.endRun(ctx, 'cancelled', 'Cancelled');
                if (!isSuccessExit(preflight.exitCode))
                    return this.executor.endRun(ctx, 'error',
                        preflight.lastError || exitCodeMessage(preflight.exitCode));
                const deleteCount = Number(preflight.stats.deletes || 0);
                ctx.logger.info(`Preflight: ${deleteCount} delete(s), limit ${allowedDeletes}`);
                const guard = assertDeleteAllowed({
                    deletes: deleteCount,
                    total: sourceCount,
                    maxDeletePercent: job.options?.maxDeletePercent ?? 10,
                    maxDeleteMinimum: job.options?.maxDeleteMinimum ?? 10,
                });
                args = withMaxDelete(args, guard.allowed);
            }
            if (dryRun)
                args = withDryRun(args);

            const result = await this.executor.runRclone(ctx, args, {
                phase: 'syncing',
                cancellable,
            });
            if (result.cancelled)
                return this.executor.endRun(ctx, 'cancelled', 'Cancelled');
            if (!isSuccessExit(result.exitCode)) {
                let message = result.lastError || exitCodeMessage(result.exitCode);
                if (/max.*delete/i.test(message)) {
                    message = `Delete limit reached (${job.options.maxDeletePercent}%). ` +
                        'Use force to override.';
                }
                return this.executor.endRun(ctx, 'error', message);
            }
            if (Number.isFinite(sourceCount) && !dryRun)
                this.executor.rememberSourceCount(job, sourceCount);
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
                throw new Error('Incremental sync requires a local source.');
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

            const normalFilter = this.executor.filterFile(job);
            for (const rel of plan.dirUpserts) {
                const sourcePath = this.files.joinPath(prep.source, rel);
                const destPath = joinRclonePath(prep.dest, rel);
                const args = copyArgs(sourcePath, destPath, normalFilter, job);
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
                const args = copyArgs(prep.source, prep.dest, includeFilter, job, {
                    noTraverse: true,
                });
                const step = await this.executor.runStep(ctx, args, {
                    phase: 'syncing',
                    cancellable,
                });
                if (step.run)
                    return step.run;
            }

            if (hasDeletes) {
                const deleteCount = await this.executor.countDeletes(
                    plan, prep, ctx, cancellable);
                const sourceCount = await this.executor.sourceCountForGuard(
                    job, prep, cancellable);
                ctx.sourceFileCount = sourceCount;
                assertDeleteAllowed({
                    deletes: deleteCount,
                    total: sourceCount,
                    maxDeletePercent: job.options?.maxDeletePercent ?? 10,
                    maxDeleteMinimum: job.options?.maxDeleteMinimum ?? 10,
                    force,
                });

                const deleteFilter = this.executor.writeIncludeFilter(ctx, 'deletes', job, {
                    files: plan.deletes,
                    dirs: plan.dirDeletes,
                });
                const step = await this.executor.runStep(ctx,
                    deleteArgs(prep.dest, deleteFilter, job), {
                        phase: 'deleting',
                        cancellable,
                    });
                if (step.run)
                    return step.run;

                const rmdirs = await this.executor.runRclone(ctx,
                    rmdirsArgs(prep.dest, deleteFilter, job), {
                        phase: 'deleting',
                        cancellable,
                    });
                if (!isSuccessExit(rmdirs.exitCode))
                    ctx.logger.warn(`rmdirs: ${rmdirs.lastError || exitCodeMessage(rmdirs.exitCode)}`);
            }

            return this.executor.endRun(ctx, 'success');
        } catch (e) {
            return this.executor.endRun(ctx, 'error', this.executor.friendlyError(e));
        }
    }
}
