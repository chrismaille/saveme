import {
    backupCurrentFor,
    isValidVersionName,
    joinRclonePath,
    versionsRootFor,
} from '../domain/backup-layout.js';
import {JOB_TYPES, jobRemoteNames, localPathFor, remotePathFor} from '../domain/job.js';
import {exitCodeMessage, isSuccessExit} from '../domain/rclone-log.js';
import {parseVersionTimestamp} from '../domain/time.js';

function entriesFromList(result, {dirsOnly = false} = {}) {
    if (result.exitCode === 3)
        return [];
    if (!isSuccessExit(result.exitCode))
        throw new Error(result.stderr.trim() || exitCodeMessage(result.exitCode));
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
            },
            settings: this.config.settings,
            pausedAll: this.state.pausedAll,
            remotes: this.config.listRemotes(),
            jobs,
            volumes: this.volumes.list(),
        });
    }

    runJob(jobId, dryRun, force) {
        const supervisor = this.manager.get(jobId);
        if (!supervisor)
            throw new Error(`Job not found: ${jobId}`);
        if (supervisor.running)
            throw new Error('Job is already running.');
        const runId = this.idFactory('run_');
        this.manager.runJob(jobId, {dryRun, force, runId}).then(run => {
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
        let saved;
        if (payload.id && this.config.getJob(payload.id))
            saved = this.config.updateJob(payload.id, payload);
        else
            saved = this.config.addJob(payload);
        this.manager.addJob(saved);
        this._snapshot(true);
        return JSON.stringify(saved);
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
        const result = this.transfer.runCapture(['lsf', root, '--dirs-only']);
        if (result.exitCode === 3)
            return JSON.stringify([]);
        if (!isSuccessExit(result.exitCode))
            throw new Error(result.stderr.trim() || exitCodeMessage(result.exitCode));
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
        const result = this.transfer.runCapture(
            dirsOnly ? ['lsf', target, '--dirs-only'] : ['lsjson', target]);
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
        const result = this.transfer.runCapture(
            dirsOnly ? ['lsf', target, '--dirs-only'] : ['lsjson', target]);
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
            .filter(job => jobRemoteNames(job).includes(name));
        if (users.length > 0) {
            throw new Error(`Remote ${name} is used by jobs: ` +
                users.map(job => job.name).join(', '));
        }
        const result = this.transfer.configDelete(name);
        if (!isSuccessExit(result.exitCode)) {
            throw new Error(result.stderr.trim() ||
                `Cannot delete remote ${name}: ${exitCodeMessage(result.exitCode)}`);
        }
        this.config.removeRemote(name);
        this.secureFile?.(this.transfer.configPath);
        this._snapshot(true);
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
        });
    }
}
