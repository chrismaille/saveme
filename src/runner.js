import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {
    JOB_TYPES,
    isLocalDescriptor,
    localPathFor,
    remotePathFor,
} from './jobs.js';
import {VolumeUnavailableError} from './volumes.js';
import {isSuccessExit, exitCodeMessage} from './rclone.js';
import {
    atomicWriteText,
    ensureDir,
    joinPath,
    nowIso,
    relativePath,
    uniqueId,
} from './util.js';
import {filtersDir, logsDir, tmpDir} from './paths.js';
import {
    DeleteGuardError,
    DestinationUnavailableError,
    EmptySourceError,
    SourceUnavailableError,
} from './domain/errors.js';
import {
    backupCurrentFor,
    backupRootFor,
    joinRclonePath,
    versionsRootFor,
    versionDirFor,
} from './domain/backup-layout.js';
import {parseVersionTimestamp} from './domain/time.js';
import {selectExpiredVersions} from './domain/retention.js';
import {assertDeleteAllowed, evaluateDeleteGuard} from './domain/delete-guard.js';
import {
    backupArgs,
    commonJobArgs,
    copyArgs,
    deleteArgs,
    escapeFilterPath,
    filterRules,
    moveArgs,
    rmdirsArgs,
    syncArgs,
    withDryRun,
    withFastList,
    withMaxDelete,
} from './domain/rclone-command.js';
import {accumulateStats, emptyStats, progressFromStats} from './domain/rclone-log.js';

export {
    DeleteGuardError,
    DestinationUnavailableError,
    EmptySourceError,
    SourceUnavailableError,
    backupCurrentFor,
    backupRootFor,
    commonJobArgs,
    escapeFilterPath,
    filterRules,
    joinRclonePath,
    parseVersionTimestamp,
    versionsRootFor,
};

class RawLog {
    constructor(path) {
        this.path = path;
        ensureDir(GLib.path_get_dirname(path), 0o700);
        const file = Gio.File.new_for_path(path);
        this._stream = file.append_to(Gio.FileCreateFlags.NONE, null);
        try {
            file.set_attribute_uint32('unix::mode', 0o600,
                Gio.FileQueryInfoFlags.NONE, null);
        } catch (_) {
            // Best effort.
        }
        this._data = Gio.DataOutputStream.new(this._stream);
    }

    write(line) {
        try {
            this._data.put_string(`${line}\n`, null);
        } catch (_) {
            // Ignore log write failures.
        }
    }

    close() {
        try {
            this._data.flush(null);
            this._data.close(null);
            this._stream.close(null);
        } catch (_) {
            // Ignore.
        }
    }
}

export class JobRunner {
    constructor({rclone, volumes, logger, state = null, config = null}) {
        this.rclone = rclone;
        this.volumes = volumes;
        this.logger = logger;
        this.state = state;
        this.config = config;
    }

    _prepare(job) {
        let source;
        let dest;
        try {
            source = isLocalDescriptor(job.source)
                ? localPathFor(job.source, this.volumes)
                : remotePathFor(job.source);
        } catch (e) {
            if (e instanceof VolumeUnavailableError)
                throw new SourceUnavailableError(`Source volume unavailable: ${e.message}`);
            throw e;
        }
        try {
            dest = isLocalDescriptor(job.destination)
                ? localPathFor(job.destination, this.volumes)
                : remotePathFor(job.destination);
        } catch (e) {
            if (e instanceof VolumeUnavailableError)
                throw new DestinationUnavailableError(`Destination volume unavailable: ${e.message}`);
            throw e;
        }
        if (!source || !dest)
            throw new Error('Source and destination are required.');

        const sourceIsLocal = isLocalDescriptor(job.source);
        const destIsLocal = isLocalDescriptor(job.destination);

        if (sourceIsLocal) {
            const file = Gio.File.new_for_path(source);
            if (!file.query_exists(null))
                throw new SourceUnavailableError(`Source does not exist: ${source}`);
            const type = file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            if (type !== Gio.FileType.DIRECTORY)
                throw new Error(`Source is not a directory: ${source}`);
        }

        if (destIsLocal) {
            const file = Gio.File.new_for_path(dest);
            if (file.query_exists(null)) {
                const type = file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
                if (type !== Gio.FileType.DIRECTORY)
                    throw new Error(`Destination is not a directory: ${dest}`);
            }
        }

        return {source, dest, sourceIsLocal, destIsLocal};
    }

    _filterFile(job) {
        ensureDir(filtersDir(), 0o700);
        const path = GLib.build_filenamev([filtersDir(), `${job.id}.txt`]);
        atomicWriteText(path, `${filterRules(job).join('\n')}\n`, 0o600);
        return path;
    }

    _beginRun(job, {dryRun, reason, incremental, runId = null}) {
        const id = runId || uniqueId('run_');
        const startedAt = nowIso();
        ensureDir(logsDir(job.id), 0o700);
        const logFile = GLib.build_filenamev([logsDir(job.id), `${id}.log`]);
        const rawLogFile = GLib.build_filenamev([logsDir(job.id), `${id}.rclone.jsonl`]);
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
            rawLog: new RawLog(rawLogFile),
            stats: emptyStats(),
            operations: [],
            tempFiles: [],
            sourceFileCount: null,
            versionsDir: null,
            currentFile: null,
            lastError: null,
            exitCode: null,
            onProgress: null,
        };
    }

    _endRun(ctx, result, message = '') {
        ctx.rawLog.close();
        const finishedAt = nowIso();
        const finalMessage = message || ctx.lastError || '';
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
        });
        ctx.logger.close();
        for (const path of ctx.tempFiles) {
            try {
                const file = Gio.File.new_for_path(path);
                if (file.query_exists(null))
                    file.delete(null);
            } catch (_) {
                // Ignore temp cleanup failures.
            }
        }
        try {
            this.state?.recordRun(run);
        } catch (e) {
            this.logger.error(`Cannot record run: ${e.message}`);
        }
        return run;
    }

    _cleanArgs(args) {
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

    async _runRclone(ctx, args, {
        phase = 'running',
        cancellable = null,
        onDataLine = null,
        mergeStats = true,
        quiet = false,
        trackError = true,
        trackExitCode = true,
    } = {}) {
        const result = await this.rclone.run(args, {
            cancellable,
            onLine: (raw, parsed) => {
                ctx.rawLog.write(raw);
                if (parsed) {
                    if (!quiet)
                        this._handleParsed(ctx, parsed);
                } else {
                    if (!quiet)
                        ctx.logger.info(raw);
                    onDataLine?.(raw);
                }
            },
            onStats: stats => {
                if (!quiet)
                    this._onStats(ctx, phase, stats);
            },
        });
        if (mergeStats)
            this._mergeStats(ctx, result.stats);
        if (trackExitCode)
            ctx.exitCode = result.exitCode;
        if (result.lastError && trackError)
            ctx.lastError = result.lastError;
        ctx.operations.push({
            args: this._cleanArgs(args),
            exitCode: result.exitCode,
        });
        return result;
    }

    _handleParsed(ctx, parsed) {
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
        if (level === 'error')
            ctx.lastError = parsed.msg;
    }

    _onStats(ctx, phase, stats) {
        const progress = progressFromStats(stats, {
            jobId: ctx.job.id,
            runId: ctx.runId,
            phase,
            currentPath: ctx.currentFile || null,
        });
        try {
            this.state?.updateProgress(ctx.job.id, progress);
        } catch (_) {
            // State writes are best effort.
        }
        ctx.onProgress?.(progress);
    }

    _mergeStats(ctx, stats) {
        accumulateStats(ctx.stats, stats);
    }

    _topLevelEntryCount(path) {
        const file = Gio.File.new_for_path(path);
        const enumerator = file.enumerate_children('standard::name',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        let count = 0;
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            if (name === '.saveme' || name === '.saveme-versions')
                continue;
            count++;
        }
        enumerator.close(null);
        return count;
    }

    async _sourceCount(job, prep, {exact, cancellable = null}) {
        if (exact) {
            const size = await this.rclone.sizeAsync(prep.source, {
                fastList: !prep.sourceIsLocal,
                cancellable,
            });
            return size.count;
        }
        if (!prep.sourceIsLocal)
            return null;
        return this._topLevelEntryCount(prep.source);
    }

    _checkEmptySource(job, sourceCount, force) {
        if (force || !Number.isFinite(sourceCount) || sourceCount > 0)
            return;
        const lastCount = this.state?.getJobState(job.id).lastSourceFileCount || 0;
        if (lastCount > 0)
            throw new EmptySourceError(lastCount);
    }

    _friendlyError(error) {
        if (error instanceof SourceUnavailableError ||
            error instanceof DestinationUnavailableError ||
            error instanceof EmptySourceError ||
            error instanceof DeleteGuardError)
            return error.message;
        return error?.message || String(error);
    }

    _versionDir(job, dest, ctx) {
        return versionDirFor(versionsRootFor(job, dest), ctx.runId);
    }

    async _listVersionDirs(ctx, root, cancellable) {
        const names = [];
        const result = await this._runRclone(ctx, ['lsf', root, '--dirs-only'], {
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

    async _cleanupVersions(ctx, job, dest, cancellable) {
        const days = Number(job.backup?.retentionDays || 0);
        if (days <= 0)
            return;
        const root = versionsRootFor(job, dest);
        let names;
        try {
            names = await this._listVersionDirs(ctx, root, cancellable);
        } catch (e) {
            ctx.logger.warn(`Cannot list versions: ${e.message}`);
            return;
        }
        const expired = selectExpiredVersions(names, {
            nowMs: Date.now(),
            retentionDays: days,
        });
        let removed = 0;
        for (const name of expired) {
            const result = await this._runRclone(ctx, ['purge', joinRclonePath(root, name)], {
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

    async runFull(job, {
        dryRun = false,
        force = false,
        reason = 'manual',
        cancellable = null,
        onProgress = null,
        runId = null,
    } = {}) {
        const ctx = this._beginRun(job, {dryRun, reason, incremental: false, runId});
        ctx.onProgress = onProgress;
        try {
            const prep = this._prepare(job);
            const exactCount = job.type === JOB_TYPES.SYNC;
            const sourceCount = await this._sourceCount(job, prep, {
                exact: exactCount,
                cancellable,
            });
            if (Number.isFinite(sourceCount))
                ctx.sourceFileCount = sourceCount;
            this._checkEmptySource(job, sourceCount, force);

            const filterFile = this._filterFile(job);
            let args;
            let allowedDeletes = null;
            if (job.type === JOB_TYPES.SYNC) {
                args = syncArgs(prep.source, prep.dest, filterFile, job);
                if (!force && !dryRun && Number.isFinite(sourceCount)) {
                    allowedDeletes = evaluateDeleteGuard({
                        deletes: 0,
                        total: sourceCount,
                        maxDeletePercent: job.options?.maxDeletePercent ?? 10,
                        maxDeleteMinimum: job.options?.maxDeleteMinimum ?? 10,
                    }).allowed;
                }
            } else {
                const current = backupCurrentFor(job, prep.dest);
                const versionDir = this._versionDir(job, prep.dest, ctx);
                ctx.versionsDir = versionDir;
                args = backupArgs(prep.source, current, versionDir, filterFile, job);
            }
            if (!prep.sourceIsLocal || !prep.destIsLocal)
                args = withFastList(args);

            if (job.type === JOB_TYPES.SYNC && !force && !dryRun &&
                allowedDeletes !== null) {
                const preflight = await this._runRclone(ctx, withDryRun(args), {
                    phase: 'checking',
                    cancellable,
                    mergeStats: false,
                    quiet: true,
                    trackError: false,
                    trackExitCode: false,
                });
                if (preflight.cancelled)
                    return this._endRun(ctx, 'cancelled', 'Cancelled');
                if (!isSuccessExit(preflight.exitCode))
                    return this._endRun(ctx, 'error',
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

            const result = await this._runRclone(ctx, args, {
                phase: 'syncing',
                cancellable,
            });
            if (result.cancelled)
                return this._endRun(ctx, 'cancelled', 'Cancelled');
            if (!isSuccessExit(result.exitCode)) {
                let message = result.lastError || exitCodeMessage(result.exitCode);
                if (/max.*delete/i.test(message)) {
                    message = `Delete limit reached (${job.options.maxDeletePercent}%). ` +
                        'Use force to override.';
                }
                return this._endRun(ctx, 'error', message);
            }
            if (job.type === JOB_TYPES.BACKUP && !dryRun)
                await this._cleanupVersions(ctx, job, prep.dest, cancellable);
            if (job.type === JOB_TYPES.SYNC && Number.isFinite(sourceCount) && !dryRun) {
                try {
                    this.state?.setJobState(job.id, {lastSourceFileCount: sourceCount});
                } catch (_) {
                    // Best effort.
                }
            }
            return this._endRun(ctx, 'success');
        } catch (e) {
            return this._endRun(ctx, 'error', this._friendlyError(e));
        }
    }

    _planChanges(job, prep, changes) {
        const upserts = new Set();
        const dirUpserts = new Set();
        const deletes = new Set();
        const dirDeletes = new Set();

        for (const change of changes) {
            const rel = relativePath(prep.source, change.path);
            if (!rel)
                continue;
            if (rel.includes('\n') || rel.includes('\r')) {
                this.logger.warn(`Ignoring path with newline: ${JSON.stringify(rel)}`);
                continue;
            }
            const file = Gio.File.new_for_path(change.path);
            const exists = file.query_exists(null);
            let kind = change.kind;
            if (!exists && (kind === 'upsert' || kind === 'dir-upsert'))
                continue;
            if (exists && (kind === 'delete' || kind === 'dir-delete'))
                kind = kind === 'delete' ? 'upsert' : 'dir-upsert';
            if (kind === 'upsert') {
                let type;
                try {
                    type = file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
                } catch (_) {
                    continue;
                }
                if (type === Gio.FileType.DIRECTORY)
                    dirUpserts.add(rel);
                else if (type === Gio.FileType.REGULAR)
                    upserts.add(rel);
                continue;
            }
            if (kind === 'dir-upsert') {
                let type;
                try {
                    type = file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
                } catch (_) {
                    continue;
                }
                if (type === Gio.FileType.DIRECTORY)
                    dirUpserts.add(rel);
                else if (type === Gio.FileType.REGULAR)
                    upserts.add(rel);
                continue;
            }
            if (kind === 'delete') {
                deletes.add(rel);
                continue;
            }
            if (kind === 'dir-delete') {
                dirDeletes.add(rel);
            }
        }

        const byDepth = (a, b) => a.split('/').length - b.split('/').length;
        const topDirsUp = [...dirUpserts].sort(byDepth).filter((dir, _index, all) =>
            !all.some(other => other !== dir && dir.startsWith(`${other}/`)));
        for (const dir of topDirsUp) {
            for (const item of [...upserts]) {
                if (item === dir || item.startsWith(`${dir}/`))
                    upserts.delete(item);
            }
            for (const item of [...deletes]) {
                if (item === dir || item.startsWith(`${dir}/`))
                    deletes.delete(item);
            }
            for (const item of [...dirDeletes]) {
                if (item === dir || item.startsWith(`${dir}/`))
                    dirDeletes.delete(item);
            }
        }

        const topDirsDelete = [...dirDeletes].sort(byDepth).filter((dir, _index, all) =>
            !all.some(other => other !== dir && dir.startsWith(`${other}/`)));
        for (const dir of topDirsDelete) {
            for (const item of [...deletes]) {
                if (item === dir || item.startsWith(`${dir}/`))
                    deletes.delete(item);
            }
        }

        return {
            upserts: [...upserts].sort(),
            dirUpserts: topDirsUp.sort(),
            deletes: [...deletes].sort(),
            dirDeletes: topDirsDelete.sort(),
        };
    }

    _writeList(ctx, suffix, values) {
        const path = GLib.build_filenamev([tmpDir(), `${ctx.runId}.${suffix}`]);
        atomicWriteText(path, values.length > 0 ? `${values.join('\n')}\n` : '', 0o600);
        ctx.tempFiles.push(path);
        return path;
    }

    _writeIncludeFilter(ctx, suffix, job, {files = [], dirs = []} = {}) {
        const rules = filterRules(job);
        for (const rel of files)
            rules.push(`+ /${escapeFilterPath(rel)}`);
        for (const rel of dirs)
            rules.push(`+ /${escapeFilterPath(rel)}/**`);
        rules.push('- *');
        const path = GLib.build_filenamev([tmpDir(), `${ctx.runId}.${suffix}`]);
        atomicWriteText(path, `${rules.join('\n')}\n`, 0o600);
        ctx.tempFiles.push(path);
        return path;
    }

    async _countDeletes(plan, prep, ctx, cancellable) {
        let count = plan.deletes.length;
        for (const rel of plan.dirDeletes) {
            const path = joinRclonePath(prep.dest, rel);
            try {
                const size = await this.rclone.sizeAsync(path, {
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

    async _sourceCountForGuard(job, prep, cancellable) {
        let count = this.state?.getJobState(job.id).lastSourceFileCount || 0;
        if (count > 0)
            return count;
        const size = await this.rclone.sizeAsync(prep.source, {
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

    async runIncremental(job, changes, {
        force = false,
        cancellable = null,
        onProgress = null,
        runId = null,
    } = {}) {
        if (changes.length > 500)
            return this.runFull(job, {reason: 'large-batch', force, cancellable, onProgress, runId});

        const ctx = this._beginRun(job, {
            dryRun: false,
            reason: 'realtime',
            incremental: true,
            runId,
        });
        ctx.onProgress = onProgress;
        try {
            const prep = this._prepare(job);
            if (!prep.sourceIsLocal)
                throw new Error('Incremental sync requires a local source.');
            const plan = this._planChanges(job, prep, changes);
            const hasUpserts = plan.upserts.length > 0 || plan.dirUpserts.length > 0;
            const hasDeletes = plan.deletes.length > 0 || plan.dirDeletes.length > 0;
            if (!hasUpserts && !hasDeletes)
                return this._endRun(ctx, 'noop', 'No effective changes.');

            const isBackup = job.type === JOB_TYPES.BACKUP;
            const current = isBackup ? backupCurrentFor(job, prep.dest) : prep.dest;
            const normalFilter = this._filterFile(job);
            const versionDir = isBackup && (hasUpserts || hasDeletes)
                ? this._versionDir(job, prep.dest, ctx)
                : null;
            if (versionDir)
                ctx.versionsDir = versionDir;

            for (const rel of plan.dirUpserts) {
                const sourcePath = joinPath(prep.source, rel);
                const destPath = joinRclonePath(current, rel);
                const args = copyArgs(sourcePath, destPath, normalFilter, job, {
                    backupDir: versionDir ? joinRclonePath(versionDir, rel) : null,
                });
                const result = await this._runRclone(ctx, args, {
                    phase: 'syncing',
                    cancellable,
                });
                if (result.cancelled)
                    return this._endRun(ctx, 'cancelled', 'Cancelled');
                if (!isSuccessExit(result.exitCode))
                    return this._endRun(ctx, 'error',
                        result.lastError || exitCodeMessage(result.exitCode));
            }

            if (plan.upserts.length > 0) {
                const includeFilter = this._writeIncludeFilter(ctx, 'upserts', job, {
                    files: plan.upserts,
                });
                const args = copyArgs(prep.source, current, includeFilter, job, {
                    noTraverse: true,
                    backupDir: versionDir,
                });
                const result = await this._runRclone(ctx, args, {
                    phase: 'syncing',
                    cancellable,
                });
                if (result.cancelled)
                    return this._endRun(ctx, 'cancelled', 'Cancelled');
                if (!isSuccessExit(result.exitCode))
                    return this._endRun(ctx, 'error',
                        result.lastError || exitCodeMessage(result.exitCode));
            }

            if (isBackup && hasDeletes && versionDir) {
                const deleteFilter = this._writeIncludeFilter(ctx, 'backup-deletes', job, {
                    files: plan.deletes,
                    dirs: plan.dirDeletes,
                });
                const moved = await this._runRclone(ctx,
                    moveArgs(current, versionDir, deleteFilter, job, {noTraverse: true}), {
                        phase: 'backing-up',
                        cancellable,
                    });
                if (moved.cancelled)
                    return this._endRun(ctx, 'cancelled', 'Cancelled');
                if (!isSuccessExit(moved.exitCode))
                    ctx.logger.warn('Could not move all deleted files to versions: ' +
                        (moved.lastError || exitCodeMessage(moved.exitCode)));
                const rmdirs = await this._runRclone(ctx,
                    rmdirsArgs(current, deleteFilter, job), {
                        phase: 'backing-up',
                        cancellable,
                    });
                if (!isSuccessExit(rmdirs.exitCode))
                    ctx.logger.warn(`rmdirs: ${rmdirs.lastError || exitCodeMessage(rmdirs.exitCode)}`);
            }

            if (!isBackup && hasDeletes) {
                const deleteCount = await this._countDeletes(plan, prep, ctx, cancellable);
                const sourceCount = await this._sourceCountForGuard(job, prep, cancellable);
                ctx.sourceFileCount = sourceCount;
                assertDeleteAllowed({
                    deletes: deleteCount,
                    total: sourceCount,
                    maxDeletePercent: job.options?.maxDeletePercent ?? 10,
                    maxDeleteMinimum: job.options?.maxDeleteMinimum ?? 10,
                    force,
                });

                const deleteFilter = this._writeIncludeFilter(ctx, 'deletes', job, {
                    files: plan.deletes,
                    dirs: plan.dirDeletes,
                });
                const result = await this._runRclone(ctx,
                    deleteArgs(current, deleteFilter, job), {
                        phase: 'deleting',
                        cancellable,
                    });
                if (result.cancelled)
                    return this._endRun(ctx, 'cancelled', 'Cancelled');
                if (!isSuccessExit(result.exitCode))
                    return this._endRun(ctx, 'error',
                        result.lastError || exitCodeMessage(result.exitCode));

                const rmdirs = await this._runRclone(ctx,
                    rmdirsArgs(current, deleteFilter, job), {
                        phase: 'deleting',
                        cancellable,
                    });
                if (!isSuccessExit(rmdirs.exitCode))
                    ctx.logger.warn(`rmdirs: ${rmdirs.lastError || exitCodeMessage(rmdirs.exitCode)}`);
            }

            if (job.type === JOB_TYPES.BACKUP && versionDir)
                await this._cleanupVersions(ctx, job, prep.dest, cancellable);

            return this._endRun(ctx, 'success');
        } catch (e) {
            return this._endRun(ctx, 'error', this._friendlyError(e));
        }
    }
}
