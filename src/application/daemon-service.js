import {
    backupCurrentFor,
    backupContainerFor,
    backupRootFor,
    isValidVersionName,
    joinRclonePath,
    versionsRootFor,
} from '../domain/backup-layout.js';
import {
    BACKUP_MANIFEST_FILE,
    parseBackupManifest,
    serializeBackupManifest,
} from '../domain/backup-manifest.js';
import {JOB_TYPES, jobRemoteNames, localPathFor, remotePathFor} from '../domain/job.js';
import {exitCodeMessage, isSuccessExit} from '../domain/rclone-log.js';
import {parseVersionTimestamp} from '../domain/time.js';

export const MAX_BROWSER_ENTRIES = 2000;

function rcloneErrorMessage(result, fallback) {
    const text = String(result.stderr || result.stdout || '').trim();
    if (!text)
        return fallback;
    let lastError = null;
    for (const line of text.split('\n')) {
        try {
            const parsed = JSON.parse(line.trim());
            if (parsed.level === 'error' || parsed.level === 'critical' || parsed.level === 'fatal')
                lastError = parsed.msg || parsed.message || line;
        } catch (_) {
            // Not a JSON log line.
        }
    }
    const message = lastError || text;
    if (/drive_id|drive_type/i.test(message)) {
        return 'The OneDrive account is misconfigured or the browser selected a different ' +
            'account than the one requested. Delete the account in Accounts, reconnect, ' +
            'and choose the correct Microsoft account in the browser (use a private window ' +
            'if needed).';
    }
    return message;
}

function entriesFromList(result, {dirsOnly = false} = {}) {
    if (result.exitCode === 3)
        return [];
    if (!isSuccessExit(result.exitCode)) {
        throw new Error(rcloneErrorMessage(result,
            exitCodeMessage(result.exitCode)));
    }
    if (dirsOnly) {
        return result.stdout.split('\n')
            .map(line => line.trim().replace(/\/$/, ''))
            .filter(Boolean)
            .map(name => ({name, isDir: true, size: 0, modTime: null}))
            .sort((a, b) => a.name.localeCompare(b.name));
    }
    let raw;
    try {
        raw = JSON.parse(result.stdout || '[]');
    } catch (e) {
        throw new Error(`Invalid rclone lsjson output: ${e.message}`, {cause: e});
    }
    const entries = raw.map(entry => ({
        name: entry.Name || entry.Path || '',
        isDir: Boolean(entry.IsDir),
        size: Number(entry.Size || 0),
        modTime: entry.ModTime || null,
    })).filter(entry => entry.name);
    entries.sort((a, b) => a.isDir === b.isDir
        ? a.name.localeCompare(b.name)
        : a.isDir ? -1 : 1);
    return entries;
}

export class DaemonService {
    constructor({
        config,
        state,
        manager,
        restore,
        auth,
        transfer,
        volumes,
        logger,
        logs = null,
        processMetrics = null,
        systemMetrics = null,
        startedAt,
        idFactory,
        getPid,
        readTextTail,
        findRclone,
        secureFile = null,
        environment = {},
        onSnapshot = null,
    }) {
        this.config = config;
        this.state = state;
        this.manager = manager;
        this.restoreService = restore;
        this.auth = auth;
        this.transfer = transfer;
        this.volumes = volumes;
        this.logger = logger;
        this.logs = logs;
        this.processMetrics = processMetrics;
        this.systemMetrics = systemMetrics;
        this.startedAt = startedAt;
        this.idFactory = idFactory;
        this.getPid = getPid;
        this.readTextTail = readTextTail;
        this.findRclone = findRclone;
        this.secureFile = secureFile;
        this.environment = environment;
        this.onSnapshot = onSnapshot;
    }

    _snapshot(force = false) {
        this.onSnapshot?.(force);
    }

    _resolveJobDestination(job) {
        return job.destination.kind === 'local'
            ? localPathFor(job.destination, this.volumes)
            : remotePathFor(job.destination);
    }

    _ensureListable(target) {
        try {
            const size = this.transfer.size(target, {
                fastList: true,
                maxDepth: 1,
            });
            const count = Number(size.count || 0);
            if (count > MAX_BROWSER_ENTRIES) {
                throw new Error(
                    `Folder has ${count} entries; open a subfolder to browse it safely.`);
            }
        } catch (e) {
            if (/open a subfolder/i.test(e.message))
                throw e;
            this.logger?.warn(`Cannot size remote folder before listing: ${e.message}`);
        }
    }

    snapshotJson() {
        const jobs = this.config.listJobs().map(job => ({
            ...job,
            state: this.state.getJobState(job.id),
        }));
        let rcloneInfo;
        try {
            const version = this.transfer.getVersion();
            rcloneInfo = {
                path: this.transfer.binary,
                version: version.text,
            };
        } catch (e) {
            rcloneInfo = {
                path: this.transfer?.binary || this.findRclone(),
                error: e.message,
            };
        }
        return JSON.stringify({
            version: this.environment.version,
            daemon: {
                pid: this.getPid(),
                startedAt: this.startedAt,
                rclone: rcloneInfo,
                process: this.processMetrics?.() || null,
            },
            settings: this.config.settings,
            pausedAll: this.state.pausedAll,
            remotes: this.config.listRemotes(),
            jobs,
            volumes: this.volumes.list(),
            system: this.systemMetrics?.() || null,
        });
    }

    runJob(jobId, dryRun, force) {
        const supervisor = this.manager.get(jobId);
        if (!supervisor)
            throw new Error(`Job not found: ${jobId}`);
        if (supervisor.running)
            throw new Error('Job is already running or queued.');
        const runId = this.idFactory('run_');
        this.manager.runJob(jobId, {dryRun, force, runId}).then(run => {
            if (!run)
                this.logger?.warn(`Run ${runId} did not start`);
        }).catch(e => {
            this.logger?.error(`Run ${runId} failed: ${e.message}`);
        });
        return runId;
    }

    playJob(jobId) {
        const supervisor = this.manager.get(jobId);
        if (!supervisor)
            throw new Error(`Job not found: ${jobId}`);
        if (supervisor.running)
            throw new Error('Job is already running or queued.');
        const runId = this.idFactory('run_');
        this.manager.playJob(jobId, {runId}).then(run => {
            if (!run)
                this.logger?.warn(`Run ${runId} did not start`);
        }).catch(e => {
            this.logger?.error(`Run ${runId} failed: ${e.message}`);
        });
        return runId;
    }

    cancelJob(jobId) {
        this.manager.cancelJob(jobId);
        this._snapshot(true);
    }

    pauseJob(jobId, paused) {
        this.manager.pauseJob(jobId, paused);
        this._snapshot(true);
    }

    setJobEnabled(jobId, enabled) {
        const job = this.config.setJobEnabled(jobId, enabled);
        this.manager.updateJob(jobId, job);
        this._snapshot(true);
    }

    pauseAll(paused) {
        this.manager.pauseAll(paused);
        this._snapshot(true);
    }

    saveJob(payloadJson) {
        const payload = JSON.parse(payloadJson);
        delete payload.state;
        const existing = payload.id ? this.config.getJob(payload.id) : null;
        // Capture before updateJob mutates the stored object.
        const wasDraft = Boolean(existing?.draft);
        let saved;
        if (payload.id && existing)
            saved = this.config.updateJob(payload.id, payload);
        else
            saved = this.config.addJob(payload);
        if (saved.type === JOB_TYPES.BACKUP) {
            try {
                if (saved.draft) {
                    // Drafts may be incomplete and must not create the backup
                    // container or a manifest yet.
                } else if (!existing || wasDraft) {
                    this._createBackupContainer(saved);
                } else {
                    this._writeManifest(saved);
                }
            } catch (e) {
                if (!existing) {
                    try {
                        this.config.removeJob(saved.id);
                    } catch (_) {
                        // Best effort.
                    }
                } else if (wasDraft) {
                    try {
                        const draft = this.config.updateJob(saved.id, {
                            ...saved,
                            draft: true,
                            enabled: false,
                        });
                        this.manager.updateJob(saved.id, draft);
                    } catch (_) {
                        // Best effort.
                    }
                }
                throw e;
            }
        }
        this.manager.addJob(saved);
        this._snapshot(true);
        return JSON.stringify(saved);
    }

    importJob(payloadJson) {
        const payload = JSON.parse(payloadJson);
        delete payload.state;
        if (!payload.id || payload.type !== JOB_TYPES.BACKUP)
            throw new Error('Only backup jobs can be recovered.');
        // A recovered job points at paths from another installation. Keep it
        // stopped until the user confirms or edits the sources.
        payload.enabled = false;
        payload.recovered = true;
        payload.trigger = {...payload.trigger, mode: 'manual'};
        const existing = this.config.getJob(payload.id);
        const saved = existing
            ? this.config.updateJob(payload.id, payload)
            : this.config.addJob(payload);
        this.manager.addJob(saved);
        this._snapshot(true);
        return JSON.stringify(saved);
    }

    inspectBackup(path) {
        const root = String(path || '').replace(/\/+$/, '');
        if (!root)
            throw new Error('Backup folder is required.');
        const jobs = [];
        for (const name of this.transfer.listDirs(root)) {
            const backupPath = joinRclonePath(root, name);
            const manifestPath = joinRclonePath(backupPath, BACKUP_MANIFEST_FILE);
            try {
                const job = parseBackupManifest(this.transfer.readText(manifestPath));
                jobs.push({id: name, backupPath, job});
            } catch (e) {
                jobs.push({id: name, backupPath, error: e.message});
            }
        }
        return JSON.stringify({path: root, jobs});
    }

    _createBackupContainer(job) {
        const destination = this._resolveJobDestination(job);
        const container = backupContainerFor(destination);
        const root = backupRootFor(job, destination);
        // SaveMe may already exist when several backup jobs share one base
        // folder. Each job owns SaveMe/<job-id>, so only that root matters.
        const adopting = this.transfer.exists(root);
        try {
            if (!adopting)
                this.transfer.mkdir(container);
            this.transfer.mkdir(root);
            this.transfer.mkdir(`${root}/current`);
            this.transfer.mkdir(`${root}/versions`);
            this._writeManifest(job, {strict: true});
        } catch (e) {
            // Remove only this job's partial folder; never purge the shared
            // SaveMe container or other jobs' backups.
            if (!adopting) {
                try {
                    this.transfer.runCapture(['purge', root]);
                } catch (cleanupError) {
                    this.logger?.warn(`Cannot clean up ${root}: ${cleanupError.message}`);
                }
            }
            throw e;
        }
    }

    _writeManifest(job, {strict = false} = {}) {
        try {
            const destination = this._resolveJobDestination(job);
            const root = backupRootFor(job, destination);
            this.transfer.writeText(
                `${root}/${BACKUP_MANIFEST_FILE}`,
                serializeBackupManifest(job));
        } catch (e) {
            if (strict)
                throw e;
            this.logger?.warn(`Cannot write backup manifest: ${e.message}`);
        }
    }

    deleteJob(jobId) {
        this.config.removeJob(jobId);
        this.manager.removeJob(jobId);
        this._snapshot(true);
    }

    getRun(jobId, runId) {
        return JSON.stringify(this.state.getRun(jobId, runId) || {});
    }

    getRunLog(jobId, runId) {
        const run = this.state.getRun(jobId, runId);
        if (!run)
            throw new Error(`Run not found: ${runId}`);
        return this.readTextTail(run.logFile, 800);
    }

    listRuns(jobId, limit) {
        return JSON.stringify(this.state.listRuns(jobId, Number(limit) || 50));
    }

    listVersions(jobId) {
        const job = this.config.getJob(jobId);
        if (!job)
            throw new Error(`Job not found: ${jobId}`);
        if (job.type !== JOB_TYPES.BACKUP)
            return JSON.stringify([]);
        const root = versionsRootFor(job, this._resolveJobDestination(job));
        const result = this.transfer.runCapture(['lsf', root, '--dirs-only', '--max-depth', '1']);
        if (result.exitCode === 3)
            return JSON.stringify([]);
        if (!isSuccessExit(result.exitCode))
            throw new Error(rcloneErrorMessage(result, exitCodeMessage(result.exitCode)));
        const versions = result.stdout.split('\n')
            .map(line => line.trim().replace(/\/$/, ''))
            .filter(Boolean)
            .map(name => ({
                name,
                date: parseVersionTimestamp(name)?.toISOString() ?? null,
            }))
            .sort((a, b) => String(b.name).localeCompare(String(a.name)));
        return JSON.stringify(versions);
    }

    listRemote(remote, path, dirsOnly) {
        if (!remote || !this.config.getRemote(remote))
            throw new Error(`Remote not found: ${remote}`);
        const cleanPath = String(path || '').replace(/^\/+|\/+$/g, '');
        const target = cleanPath ? `${remote}:${cleanPath}` : `${remote}:`;
        this._ensureListable(target);
        const result = this.transfer.runCapture(
            dirsOnly
                ? ['lsf', target, '--dirs-only', '--max-depth', '1']
                : ['lsjson', target, '--max-depth', '1']);
        return JSON.stringify(entriesFromList(result, {dirsOnly}));
    }

    listBackup(jobId, version, path, dirsOnly) {
        const job = this.config.getJob(jobId);
        if (!job)
            throw new Error(`Job not found: ${jobId}`);
        if (job.type !== JOB_TYPES.BACKUP)
            throw new Error('This job is not a backup job.');
        const dest = this._resolveJobDestination(job);
        let root;
        if (version) {
            if (!isValidVersionName(version))
                throw new Error('Invalid version name.');
            root = joinRclonePath(versionsRootFor(job, dest), version);
        } else {
            root = backupCurrentFor(job, dest);
        }
        const cleanPath = String(path || '').replace(/^\/+|\/+$/g, '');
        const target = cleanPath ? joinRclonePath(root, cleanPath) : root;
        this._ensureListable(target);
        const result = this.transfer.runCapture(
            dirsOnly
                ? ['lsf', target, '--dirs-only', '--max-depth', '1']
                : ['lsjson', target, '--max-depth', '1']);
        return JSON.stringify(entriesFromList(result, {dirsOnly}));
    }

    restore(payloadJson) {
        const payload = JSON.parse(payloadJson);
        const job = this.config.getJob(payload.jobId);
        if (!job)
            throw new Error(`Job not found: ${payload.jobId}`);
        const destination = this._resolveJobDestination(job);
        const result = this.restoreService.restore({job, destination, payload});
        this._snapshot(true);
        return JSON.stringify(result);
    }

    beginRemoteAuth(provider, name, optionsJson) {
        const options = optionsJson ? JSON.parse(optionsJson) : {};
        return this.auth.begin(provider, name, options);
    }

    getRemoteAuth(authId) {
        return this.auth.get(authId);
    }

    cancelRemoteAuth(authId) {
        this.auth.cancel(authId);
    }

    deleteRemote(name) {
        const users = this.config.listJobs()
            .filter(job => !job.draft && jobRemoteNames(job).includes(name));
        if (users.length > 0) {
            throw new Error(`Remote ${name} is used by jobs: ` +
                users.map(job => job.name).join(', '));
        }
        const result = this.transfer.configDelete(name);
        if (!isSuccessExit(result.exitCode)) {
            throw new Error(rcloneErrorMessage(result,
                `Cannot delete remote ${name}: ${exitCodeMessage(result.exitCode)}`));
        }
        this.config.removeRemote(name);
        this.secureFile?.(this.transfer.configPath);
        this._snapshot(true);
    }

    logsInfoJson() {
        if (!this.logs)
            throw new Error('Log management is not available.');
        return JSON.stringify(this.logs.info());
    }

    pruneLogsJson() {
        if (!this.logs)
            throw new Error('Log management is not available.');
        return JSON.stringify(this.logs.prune());
    }

    clearLogsJson(scope) {
        if (!this.logs)
            throw new Error('Log management is not available.');
        return JSON.stringify(this.logs.clear(scope));
    }

    sanitizeLogsJson() {
        if (!this.logs)
            throw new Error('Log management is not available.');
        return JSON.stringify(this.logs.sanitize());
    }

    updateSettingsJson(payloadJson) {
        const payload = JSON.parse(payloadJson);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload))
            throw new Error('Invalid settings payload.');
        const settings = this.config.updateSettings(payload);
        if (Object.prototype.hasOwnProperty.call(payload, 'maxConcurrentJobs'))
            this.manager.setConcurrency?.(settings.maxConcurrentJobs);
        this.logs?.prune();
        return JSON.stringify(settings);
    }

    doctorJson() {
        let rcloneInfo;
        try {
            const version = this.transfer.getVersion();
            rcloneInfo = {
                ok: true,
                path: this.transfer.binary,
                version: version.text,
                minimum: '1.60.0',
                supported: this.transfer.checkVersion('1.60.0'),
            };
        } catch (e) {
            rcloneInfo = {ok: false, error: e.message};
        }
        return JSON.stringify({
            version: this.environment.version,
            gjs: this.environment.gjs,
            configDir: this.environment.configDir,
            stateDir: this.environment.stateDir,
            rclone: rcloneInfo,
            volumes: this.volumes.list(),
            jobs: this.config.listJobs().length,
            remotes: this.config.listRemoteNames(),
            pausedAll: this.state.pausedAll,
            logs: this.logs?.info() || null,
            process: this.processMetrics?.() || null,
            system: this.systemMetrics?.() || null,
        });
    }
}
