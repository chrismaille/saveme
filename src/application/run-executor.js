import {
    joinRclonePath,
    versionDirFor,
    versionsRootFor,
} from '../domain/backup-layout.js';
import {selectExpiredVersions} from '../domain/retention.js';
import {
    accumulateStats,
    emptyStats,
    exitCodeMessage,
    isSuccessExit,
    progressFromStats,
} from '../domain/rclone-log.js';
import {escapeFilterPath, filterRules} from '../domain/rclone-command.js';
import {
    DiskSpaceError,
    EmptySourceError,
    SourceChangedError,
} from '../domain/errors.js';
import {friendlyError as toFriendlyError} from './friendly-errors.js';
import {DEFAULT_DISK_GUARD, planDiskCheck} from '../domain/disk-space.js';

export class RunExecutor {
    constructor({
        transfer,
        files,
        logger,
        state,
        runRepository,
        clock,
        paths,
        rawLogFactory,
        getSettings = () => ({}),
        idFactory = prefix => `${prefix}${Date.now().toString(36)}`,
    }) {
        this.transfer = transfer;
        this.files = files;
        this.logger = logger;
        this.state = state;
        this.runRepository = runRepository;
        this.clock = clock;
        this.paths = paths;
        this.rawLogFactory = rawLogFactory;
        this.getSettings = getSettings;
        this.idFactory = idFactory;
    }

    beginRun(job, {dryRun, reason, incremental, runId = null}) {
        const id = runId || this.idFactory('run_');
        const startedAt = this.clock.nowIso();
        this.files.ensureDir(this.paths.logsDir(job.id), 0o700);
        const logFile = this.paths.join(this.paths.logsDir(job.id), `${id}.log`);
        const rawLogFile = this.paths.join(
            this.paths.logsDir(job.id), `${id}.rclone.jsonl`);
        const logger = this.logger.child(job.name || job.id, logFile);
        logger.info(`Starting ${job.type}${dryRun ? ' (dry run)' : ''}`, {
            jobId: job.id,
            reason,
            incremental,
        });
        try {
            this.state?.setJobState(job.id, {
                status: 'running',
                message: '',
                progress: null,
                dryRun: Boolean(dryRun),
            });
        } catch (e) {
            logger.warn(`Cannot update state: ${e.message}`);
        }
        return {
            job,
            runId: id,
            startedAt,
            dryRun,
            reason,
            incremental,
            logger,
            rawLog: this.rawLogFactory.create(rawLogFile),
            stats: emptyStats(),
            operations: [],
            tempFiles: [],
            sourceFileCount: null,
            versionsDir: null,
            currentFile: null,
            lastError: null,
            deleteGuardHit: false,
            exitCode: null,
            onProgress: null,
            progressMapper: null,
            progress: null,
        };
    }

    endRun(ctx, result, message = '') {
        ctx.rawLog.close();
        const finishedAt = this.clock.nowIso();
        const error = result === 'error' && message instanceof Error
            ? message
            : null;
        const technicalMessage = error
            ? error.message
            : (message || ctx.lastError || '');
        const finalMessage = result === 'error'
            ? (error ? toFriendlyError(error) : toFriendlyError(technicalMessage))
            : technicalMessage;
        const run = {
            id: ctx.runId,
            jobId: ctx.job.id,
            jobName: ctx.job.name,
            kind: ctx.job.type,
            incremental: ctx.incremental,
            dryRun: ctx.dryRun,
            reason: ctx.reason,
            startedAt: ctx.startedAt,
            finishedAt,
            result,
            exitCode: ctx.exitCode,
            message: finalMessage,
            technicalMessage: technicalMessage && technicalMessage !== finalMessage
                ? technicalMessage
                : undefined,
            stats: ctx.stats,
            sourceFileCount: Number.isFinite(ctx.sourceFileCount) ? ctx.sourceFileCount : undefined,
            versionsDir: ctx.versionsDir || undefined,
            logFile: ctx.logger.filePath,
            rawLogFile: ctx.rawLog.path,
            operations: ctx.operations,
        };
        ctx.logger.info(`Finished: ${result}`, {
            files: ctx.stats.transfers,
            bytes: ctx.stats.bytes,
            deletes: ctx.stats.deletes,
            errors: ctx.stats.errors,
            message: finalMessage || undefined,
            technicalMessage: run.technicalMessage,
        });
        ctx.logger.close();
        try {
            this.state?.setJobState(ctx.job.id, {dryRun: false, progress: null});
        } catch (_) {
            // Best effort.
        }
        for (const path of ctx.tempFiles) {
            try {
                this.files.removeIfExists(path);
            } catch (_) {
                // Ignore temp cleanup failures.
            }
        }
        try {
            this.runRepository.recordRun(run);
        } catch (e) {
            this.logger.error(`Cannot record run: ${e.message}`);
        }
        return run;
    }

    cleanArgs(args) {
        const cleaned = [];
        for (let i = 0; i < args.length; i++) {
            if (args[i] === '--config') {
                i++;
                continue;
            }
            cleaned.push(args[i]);
        }
        return cleaned;
    }

    async runRclone(ctx, args, {
        phase = 'running',
        cancellable = null,
        onDataLine = null,
        mergeStats = true,
        quiet = false,
        trackError = true,
        trackExitCode = true,
    } = {}) {
        const result = await this.transfer.run(args, {
            cancellable,
            onLine: (raw, parsed) => {
                ctx.rawLog.write(raw);
                if (parsed) {
                    if (!quiet)
                        this.handleParsed(ctx, parsed);
                } else {
                    if (!quiet)
                        ctx.logger.info(raw);
                    onDataLine?.(raw);
                }
            },
            onStats: stats => {
                if (!quiet)
                    this.onStats(ctx, phase, stats);
            },
        });
        if (mergeStats)
            this.mergeStats(ctx, result.stats);
        if (trackExitCode)
            ctx.exitCode = result.exitCode;
        if (result.lastError && trackError)
            ctx.lastError = result.lastError;
        ctx.operations.push({
            args: this.cleanArgs(args),
            exitCode: result.exitCode,
        });
        return result;
    }

    async runStep(ctx, args, options = {}) {
        const result = await this.runRclone(ctx, args, options);
        if (result.cancelled)
            return {result, run: this.endRun(ctx, 'cancelled', 'Cancelled')};
        if (!isSuccessExit(result.exitCode)) {
            return {
                result,
                run: this.endRun(ctx, 'error',
                    result.lastError || exitCodeMessage(result.exitCode)),
            };
        }
        return {result, run: null};
    }

    handleParsed(ctx, parsed) {
        if (parsed.stats)
            return;
        if (!parsed.msg)
            return;
        const level = parsed.level === 'error' || parsed.level === 'critical'
            ? 'error'
            : parsed.level === 'warning' ? 'warn' : 'info';
        const fields = {};
        if (parsed.object)
            fields.object = parsed.object;
        if (parsed.size)
            fields.size = parsed.size;
        ctx.logger[level](String(parsed.msg).trim(), fields);
        if (parsed.object)
            ctx.currentFile = parsed.object;
        if (/max-delete|maximum delete|delete threshold/i.test(parsed.msg))
            ctx.deleteGuardHit = true;
        if (level === 'error')
            ctx.lastError = parsed.msg;
    }

    onStats(ctx, phase, stats) {
        let progress = progressFromStats(stats, {
            jobId: ctx.job.id,
            runId: ctx.runId,
            phase,
            currentPath: ctx.currentFile || null,
        });
        if (ctx.progressMapper)
            progress = ctx.progressMapper(progress) || progress;
        progress = this.smoothProgress(ctx, progress);
        progress.dryRun = Boolean(ctx.dryRun);
        ctx.progress = progress;
        try {
            this.state?.updateProgress(ctx.job.id, progress);
        } catch (_) {
            // State writes are best effort.
        }
        ctx.onProgress?.(progress);
    }

    smoothProgress(ctx, progress) {
        const previous = ctx.smoothedProgress || {};
        const next = {...progress};
        const peak = key => Math.max(
            Number(previous[key] || 0),
            Number(progress[key] || 0));
        // rclone discovers files while it works, so its totals and ETA can
        // move backwards. Keep displayed totals and work done monotonic.
        next.bytes = peak('bytes');
        next.files = peak('files');
        next.totalBytes = peak('totalBytes');
        next.totalFiles = peak('totalFiles');
        const total = next.totalBytes > 0 ? next.totalBytes : next.totalFiles;
        const done = next.totalBytes > 0 ? next.bytes : next.files;
        const computed = total > 0 ? (done / total) * 100 : 0;
        next.percent = Math.min(95, Math.max(
            Number(previous.percent || 0),
            Number(progress.percent || 0),
            computed));
        const speed = Number(progress.speed || 0);
        const previousSpeed = Number(previous.speed || 0);
        next.speed = speed > 0
            ? (previousSpeed > 0 ? previousSpeed * 0.7 + speed * 0.3 : speed)
            : previousSpeed;
        let eta = null;
        if (next.speed > 0 && next.totalBytes > 0) {
            eta = Math.max(0, (next.totalBytes - next.bytes) / next.speed);
        } else if (progress.eta !== null && progress.eta !== undefined &&
            Number.isFinite(Number(progress.eta)) && Number(progress.eta) >= 0) {
            eta = Number(progress.eta);
        }
        const hasPreviousEta = previous.eta !== null && previous.eta !== undefined;
        const previousEta = hasPreviousEta ? Number(previous.eta) : Number.NaN;
        if (eta === null && Number.isFinite(previousEta) && previousEta >= 0)
            eta = previousEta;
        else if (eta !== null && Number.isFinite(previousEta) && previousEta >= 0)
            eta = previousEta * 0.6 + eta * 0.4;
        next.eta = eta;
        ctx.smoothedProgress = next;
        return next;
    }

    updateProgress(ctx, patch) {
        const progress = {
            jobId: ctx.job.id,
            runId: ctx.runId,
            phase: 'running',
            percent: 0,
            dryRun: Boolean(ctx.dryRun),
            ...(ctx.progress || {}),
            ...patch,
        };
        if (patch.percent !== undefined && patch.phase !== 'done') {
            const previous = Number(ctx.progress?.percent || 0);
            progress.percent = Math.max(previous, Number(patch.percent || 0));
        }
        ctx.progress = progress;
        try {
            this.state?.updateProgress(ctx.job.id, progress);
        } catch (_) {
            // State writes are best effort.
        }
        ctx.onProgress?.(progress);
    }

    mergeStats(ctx, stats) {
        accumulateStats(ctx.stats, stats);
    }

    filterFile(job) {
        const directory = this.paths.filtersDir();
        this.files.ensureDir(directory, 0o700);
        const path = this.paths.join(directory, `${job.id}.txt`);
        this.files.writeText(path, `${filterRules(job).join('\n')}\n`, 0o600);
        return path;
    }

    async sourceCount(job, prep, options) {
        return (await this.sourceStats(job, prep, options)).count;
    }

    async sourceStats(job, prep, {exact, cancellable = null} = {}) {
        if (exact) {
            const size = await this.transfer.sizeAsync(prep.source, {
                fastList: !prep.sourceIsLocal,
                cancellable,
            });
            return {
                count: size.count === undefined ? 0 : Number(size.count),
                bytes: size.bytes === undefined ? 0 : Number(size.bytes),
            };
        }
        if (!prep.sourceIsLocal)
            return {count: null, bytes: null};
        return {
            count: this.files.topLevelEntryCount(prep.source, {
                ignore: ['.saveme', '.saveme-versions'],
            }),
            bytes: null,
        };
    }

    checkDiskSpace(job, prep, sourceBytes) {
        if (sourceBytes === null || sourceBytes === undefined)
            return null;
        const source = Number(sourceBytes);
        if (!Number.isFinite(source))
            return null;
        let free;
        const diskDest = prep.destBase || prep.dest;
        if (prep.destIsLocal) {
            if (typeof this.files.freeSpace !== 'function')
                return null;
            free = this.files.freeSpace(diskDest);
        } else {
            if (typeof this.transfer.about !== 'function')
                return null;
            try {
                const remote = String(diskDest || '');
                const colon = remote.indexOf(':');
                const root = colon > 0 ? `${remote.slice(0, colon)}:` : remote;
                const about = this.transfer.about(root);
                free = about?.free;
            } catch (e) {
                this.logger?.warn(`Cannot read remote free space: ${e.message}`);
                return null;
            }
        }
        if (free === null || free === undefined)
            return null;
        const freeBytes = Number(free);
        if (!Number.isFinite(freeBytes))
            return null;
        const settings = this.getSettings() || {};
        const plan = planDiskCheck({
            sourceBytes: source,
            freeBytes,
            safetyPercent: settings.diskSafetyPercent ??
                DEFAULT_DISK_GUARD.safetyPercent,
            minimumFreeBytes: Number(settings.minFreeSpaceMb ??
                DEFAULT_DISK_GUARD.minimumFreeBytes / (1024 * 1024)) * 1024 * 1024,
            factor: job.type === 'backup' ? 1.25 : 1,
        });
        if (!plan.checked)
            return null;
        if (!plan.ok) {
            throw new DiskSpaceError({
                freeBytes: plan.freeBytes,
                requiredBytes: plan.requiredBytes,
                destination: prep.dest,
            });
        }
        this.logger?.info('Disk space check', {
            sourceBytes: plan.sourceBytes,
            freeBytes: plan.freeBytes,
            requiredBytes: plan.requiredBytes,
        });
        return plan;
    }

    quickSourceCount(prep) {
        if (!prep.sourceIsLocal || typeof this.files.topLevelEntryCount !== 'function')
            return null;
        try {
            return this.files.topLevelEntryCount(prep.source, {
                ignore: ['.saveme', '.saveme-versions'],
            });
        } catch (_) {
            return null;
        }
    }

    lastSuccessfulSourceCount(job) {
        const state = this.state?.getJobState?.(job.id) || {};
        const stateCount = Number(state.lastSourceFileCount || 0);
        const stateIsSuccessful = !state.lastResult ||
            state.lastResult === 'success' || state.lastResult === 'noop';
        if (stateIsSuccessful)
            return Number.isFinite(stateCount) ? stateCount : 0;
        let runs;
        try {
            runs = this.runRepository?.listRuns?.(job.id, 100) || [];
        } catch (_) {
            runs = [];
        }
        const previous = runs.find(run => !run.dryRun &&
            (run.result === 'success' || run.result === 'noop') &&
            Number.isFinite(Number(run.sourceFileCount)));
        return previous
            ? Number(previous.sourceFileCount)
            : (Number.isFinite(stateCount) ? stateCount : 0);
    }

    checkEmptySource(job, sourceCount, force, previousCount = null) {
        if (force || !Number.isFinite(sourceCount) || sourceCount > 0)
            return;
        const lastCount = previousCount ?? this.lastSuccessfulSourceCount(job);
        if (lastCount > 0)
            throw new EmptySourceError(lastCount);
    }

    checkSourceChange(job, sourceCount, {
        force = false,
        enabled = true,
        previousCount = null,
    } = {}) {
        if (force || !enabled || !Number.isFinite(sourceCount) || sourceCount <= 0)
            return null;
        const previous = previousCount ?? this.lastSuccessfulSourceCount(job);
        if (!Number.isFinite(previous) || previous < 100)
            return null;
        if (sourceCount >= previous * 0.5)
            return null;
        throw new SourceChangedError(sourceCount, previous);
    }

    friendlyError(error) {
        return toFriendlyError(error);
    }

    versionDir(job, dest, ctx) {
        return versionDirFor(versionsRootFor(job, dest), ctx.runId, this.clock.newDate());
    }

    async listVersionDirs(ctx, root, cancellable) {
        const names = [];
        const result = await this.runRclone(ctx, ['lsf', root, '--dirs-only'], {
            phase: 'cleanup',
            cancellable,
            quiet: true,
            mergeStats: false,
            trackError: false,
            trackExitCode: false,
            onDataLine: raw => {
                const name = raw.trim().replace(/\/$/, '');
                if (name)
                    names.push(name);
            },
        });
        if (result.exitCode === 3)
            return [];
        if (!isSuccessExit(result.exitCode))
            throw new Error(result.lastError || exitCodeMessage(result.exitCode));
        return names;
    }

    async cleanupVersions(ctx, job, dest, cancellable) {
        if (job.backup?.keepForever)
            return;
        const days = Number(job.backup?.retentionDays || 0);
        if (days <= 0)
            return;
        const root = versionsRootFor(job, dest);
        let names;
        try {
            names = await this.listVersionDirs(ctx, root, cancellable);
        } catch (e) {
            ctx.logger.warn(`Cannot list versions: ${e.message}`);
            return;
        }
        const expired = selectExpiredVersions(names, {
            nowMs: this.clock.nowMs(),
            retentionDays: days,
        });
        let removed = 0;
        for (const name of expired) {
            const result = await this.runRclone(ctx, ['purge', joinRclonePath(root, name)], {
                phase: 'cleanup',
                cancellable,
                mergeStats: false,
                trackError: false,
                trackExitCode: false,
            });
            if (isSuccessExit(result.exitCode))
                removed++;
            else
                ctx.logger.warn(`Cannot remove old version ${name}: ` +
                    `${result.lastError || exitCodeMessage(result.exitCode)}`);
        }
        if (removed > 0)
            ctx.logger.info(`Removed ${removed} old version(s)`);
    }

    writeList(ctx, suffix, values) {
        const path = this.paths.join(this.paths.tmpDir(), `${ctx.runId}.${suffix}`);
        this.files.writeText(path, values.length > 0 ? `${values.join('\n')}\n` : '', 0o600);
        ctx.tempFiles.push(path);
        return path;
    }

    writeIncludeFilter(ctx, suffix, job, {files = [], dirs = []} = {}) {
        const rules = filterRules(job, {includeSelection: false});
        for (const rel of files)
            rules.push(`+ /${escapeFilterPath(rel)}`);
        for (const rel of dirs)
            rules.push(`+ /${escapeFilterPath(rel)}/**`);
        rules.push('- *');
        const path = this.paths.join(this.paths.tmpDir(), `${ctx.runId}.${suffix}`);
        this.files.writeText(path, `${rules.join('\n')}\n`, 0o600);
        ctx.tempFiles.push(path);
        return path;
    }

    async countDeletes(plan, prep, ctx, cancellable) {
        let count = plan.deletes.length;
        for (const rel of plan.dirDeletes) {
            const path = joinRclonePath(prep.dest, rel);
            try {
                const size = await this.transfer.sizeAsync(path, {
                    fastList: !prep.destIsLocal,
                    cancellable,
                });
                count += Number(size.count || 0);
            } catch (e) {
                if (/not found|directory not found/i.test(e.message))
                    continue;
                throw e;
            }
        }
        return count;
    }

    async sourceCountForGuard(job, prep, cancellable) {
        let count = this.state?.getJobState(job.id).lastSourceFileCount || 0;
        if (count > 0)
            return count;
        const size = await this.transfer.sizeAsync(prep.source, {
            fastList: !prep.sourceIsLocal,
            cancellable,
        });
        count = Number(size.count || 0);
        try {
            this.state?.setJobState(job.id, {lastSourceFileCount: count});
        } catch (_) {
            // Best effort.
        }
        return count;
    }

    rememberSourceCount(job, count) {
        try {
            this.state?.setJobState(job.id, {lastSourceFileCount: count});
        } catch (_) {
            // Best effort.
        }
    }
}
