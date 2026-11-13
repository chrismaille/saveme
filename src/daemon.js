import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';
import GObject from 'gi://GObject';
import system from 'system';
import {ConfigStore} from './config.js';
import {StateStore} from './state.js';
import {VolumeResolver} from './volumes.js';
import {Rclone, findRclone, isSuccessExit, exitCodeMessage} from './rclone.js';
import {
    JobRunner,
    backupCurrentFor,
    joinRclonePath,
    versionsRootFor,
    parseVersionTimestamp,
} from './runner.js';
import {JobManager} from './supervisor.js';
import {RemoteAuthManager} from './auth.js';
import {Logger, readTextTail} from './log.js';
import {DAEMON_INTERFACE} from './dbus.js';
import {
    DAEMON_APP_ID,
    DAEMON_OBJECT_PATH,
    configDir,
    rcloneConfigFile,
    stateDir,
} from './paths.js';
import {jobRemoteNames, localPathFor, remotePathFor} from './jobs.js';
import {ensureDir, joinPath, nowIso, uniqueId} from './util.js';

const VERSION = '1.0.0-dev';

function getPid() {
    try {
        const [, bytes] = GLib.file_get_contents('/proc/self/stat');
        return Number(new TextDecoder().decode(bytes).split(' ')[0]);
    } catch (_) {
        return null;
    }
}

function validateVersionName(name) {
    return parseVersionTimestamp(name) !== null && !name.includes('/');
}

function validateRelativePath(path) {
    return !String(path).split('/').some(part => part === '..');
}

export class DaemonApi {
    constructor(daemon) {
        this.daemon = daemon;
    }

    GetSnapshot() {
        return this.daemon.snapshotJson();
    }

    RunJob(jobId, dryRun, force) {
        return this.daemon.runJob(jobId, Boolean(dryRun), Boolean(force));
    }

    CancelJob(jobId) {
        this.daemon.cancelJob(jobId);
    }

    PauseJob(jobId, paused) {
        this.daemon.pauseJob(jobId, Boolean(paused));
    }

    SetJobEnabled(jobId, enabled) {
        this.daemon.setJobEnabled(jobId, Boolean(enabled));
    }

    PauseAll(paused) {
        this.daemon.pauseAll(Boolean(paused));
    }

    SaveJob(payloadJson) {
        return this.daemon.saveJob(payloadJson);
    }

    DeleteJob(jobId) {
        this.daemon.deleteJob(jobId);
    }

    GetRun(jobId, runId) {
        return this.daemon.getRun(jobId, runId);
    }

    GetRunLog(jobId, runId) {
        return this.daemon.getRunLog(jobId, runId);
    }

    ListRuns(jobId, limit) {
        return this.daemon.listRuns(jobId, limit);
    }

    ListVersions(jobId) {
        return this.daemon.listVersions(jobId);
    }

    ListRemote(remote, path, dirsOnly) {
        return this.daemon.listRemote(remote, path, Boolean(dirsOnly));
    }

    ListBackup(jobId, version, path, dirsOnly) {
        return this.daemon.listBackup(jobId, version, path, Boolean(dirsOnly));
    }

    Restore(payloadJson) {
        return this.daemon.restore(payloadJson);
    }

    BeginRemoteAuth(provider, name, optionsJson) {
        return this.daemon.beginRemoteAuth(provider, name, optionsJson);
    }

    GetRemoteAuth(authId) {
        return this.daemon.getRemoteAuth(authId);
    }

    CancelRemoteAuth(authId) {
        this.daemon.cancelRemoteAuth(authId);
    }

    DeleteRemote(name) {
        this.daemon.deleteRemote(name);
    }

    Doctor() {
        return this.daemon.doctorJson();
    }

    Quit() {
        this.daemon.quit();
    }
}

export const SaveMeDaemonApplication = GObject.registerClass({
    GTypeName: 'SaveMeDaemonApplication',
}, class SaveMeDaemonApplication extends Gio.Application {
    constructor() {
        super({
            application_id: DAEMON_APP_ID,
            flags: Gio.ApplicationFlags.IS_SERVICE,
        });
        this._startedAt = nowIso();
        this._logger = null;
        this._config = null;
        this._state = null;
        this._volumes = null;
        this._rclone = null;
        this._runner = null;
        this._manager = null;
        this._auth = null;
        this._dbus = null;
        this._api = null;
        this._snapshotTimer = null;
        this._lastSnapshot = null;
        this._logindSubscription = null;
        this._network = null;
        this._networkHandler = null;
        this._volumeConnected = false;
        this._settingsAction = null;
    }

    vfunc_startup() {
        super.vfunc_startup();
        ensureDir(stateDir(), 0o700);
        this._logger = new Logger({
            name: 'daemon',
            filePath: GLib.build_filenamev([stateDir(), 'daemon.log']),
            level: 'info',
            echo: true,
        });
        this._logger.info(`SaveMe daemon ${VERSION} starting`, {
            config: configDir(),
            state: stateDir(),
        });

        this._config = new ConfigStore({logger: this._logger});
        this._config.load();
        this._state = new StateStore({logger: this._logger});
        this._state.load();
        this._state.resetRunningJobs();

        this._volumes = new VolumeResolver();
        this._rclone = new Rclone({
            configPath: rcloneConfigFile(),
            logger: this._logger,
        });
        try {
            const version = this._rclone.getVersion();
            this._logger.info(`Using rclone ${version.text} at ${this._rclone.binary}`);
            if (!this._rclone.checkVersion('1.60.0'))
                this._logger.warn('rclone is older than 1.60.0');
        } catch (e) {
            this._logger.error(`rclone unavailable: ${e.message}`);
        }

        this._runner = new JobRunner({
            rclone: this._rclone,
            volumes: this._volumes,
            logger: this._logger,
            state: this._state,
            config: this._config,
        });
        this._manager = new JobManager({
            config: this._config,
            state: this._state,
            runner: this._runner,
            logger: this._logger,
            onChange: () => this._markDirty(),
            onRunFinished: run => this._onRunFinished(run),
            onNotify: notification => this._onNotify(notification),
        });
        this._auth = new RemoteAuthManager({
            rclone: this._rclone,
            config: this._config,
            logger: this._logger,
            onChange: (authId, json) => this._onRemoteAuthChanged(authId, json),
        });

        this._api = new DaemonApi(this);
        this._exportDbus();
        this._setupActions();
        this._setupVolumes();
        this._setupNetwork();
        this._setupLogind();
        this._snapshotTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._emitSnapshot();
            return GLib.SOURCE_CONTINUE;
        });
        this._manager.start();
        this._emitSnapshot(true);
        this.hold();
    }

    vfunc_activate() {
        // The daemon has no window. Activation is a no-op.
    }

    vfunc_shutdown() {
        if (this._snapshotTimer) {
            GLib.source_remove(this._snapshotTimer);
            this._snapshotTimer = null;
        }
        this._manager?.stopAll();
        this._auth?.stop();
        if (this._volumeConnected) {
            this._volumes?.disconnect();
            this._volumeConnected = false;
        }
        if (this._networkHandler && this._network) {
            this._network.disconnect(this._networkHandler);
            this._networkHandler = null;
        }
        if (this._logindSubscription) {
            try {
                const connection = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
                connection.signal_unsubscribe(this._logindSubscription);
            } catch (_) {
                // Ignore.
            }
            this._logindSubscription = null;
        }
        if (this._dbus) {
            try {
                this._dbus.unexport();
            } catch (_) {
                // Ignore.
            }
            this._dbus = null;
        }
        this._logger?.info('SaveMe daemon stopping');
        this._logger?.close();
        this.release();
        super.vfunc_shutdown();
    }

    _exportDbus() {
        let connection = this.get_dbus_connection();
        if (!connection)
            connection = Gio.bus_get_sync(Gio.BusType.SESSION, null);
        this._connection = connection;
        this._dbus = Gio.DBusExportedObject.wrapJSObject(DAEMON_INTERFACE, this._api);
        this._dbus.export(connection, DAEMON_OBJECT_PATH);
        this._logger?.info(`D-Bus interface exported at ${DAEMON_OBJECT_PATH}`);
    }

    _setupActions() {
        const action = new Gio.SimpleAction({name: 'open-settings'});
        action.connect('activate', () => {
            try {
                const program = GLib.find_program_in_path('saveme-settings');
                if (program)
                    Gio.Subprocess.new([program], Gio.SubprocessFlags.NONE);
                else
                    Gio.Subprocess.new(['gjs', '-m', 'app/main.js'], Gio.SubprocessFlags.NONE);
            } catch (e) {
                this._logger?.warn(`Cannot open settings: ${e.message}`);
            }
        });
        this.add_action(action);
        this._settingsAction = action;
    }

    _setupVolumes() {
        this._volumes.connect(() => {
            this._manager?.onMountChanged();
            this._markDirty();
        });
        this._volumeConnected = true;
    }

    _setupNetwork() {
        this._network = Gio.NetworkMonitor.get_default();
        this._networkHandler = this._network.connect('network-changed',
            (_monitor, available) => {
                this._manager?.onNetworkChanged(available);
                this._markDirty();
            });
    }

    _setupLogind() {
        try {
            const connection = Gio.bus_get_sync(Gio.BusType.SYSTEM, null);
            this._logindSubscription = connection.signal_subscribe(
                'org.freedesktop.login1',
                'org.freedesktop.login1.Manager',
                'PrepareForSleep',
                '/org/freedesktop/login1',
                null,
                Gio.DBusSignalFlags.NONE,
                (_connection, _sender, _path, _iface, _signal, params) => {
                    const sleeping = params.deepUnpack()[0];
                    if (!sleeping) {
                        this._logger?.info('Resumed from sleep');
                        this._manager?.onResume();
                    }
                });
        } catch (e) {
            this._logger?.warn(`Cannot subscribe to logind: ${e.message}`);
        }
    }

    _markDirty() {
        this._dirty = true;
    }

    _emitSnapshot(force = false) {
        if (!this._dbus)
            return;
        const json = this.snapshotJson();
        if (!force && json === this._lastSnapshot)
            return;
        this._lastSnapshot = json;
        try {
            this._dbus.emit_signal('SnapshotChanged',
                new GLib.Variant('(s)', [json]));
        } catch (e) {
            this._logger?.warn(`Cannot emit snapshot: ${e.message}`);
        }
    }

    _onRunFinished(run) {
        this._emitSnapshot(true);
        try {
            this._dbus?.emit_signal('RunFinished',
                new GLib.Variant('(sss)', [run.jobId, run.id, JSON.stringify(run)]));
        } catch (e) {
            this._logger?.warn(`Cannot emit RunFinished: ${e.message}`);
        }
    }

    _onRemoteAuthChanged(authId, json) {
        this._markDirty();
        try {
            this._dbus?.emit_signal('RemoteAuthChanged',
                new GLib.Variant('(ss)', [authId, json]));
        } catch (e) {
            this._logger?.warn(`Cannot emit RemoteAuthChanged: ${e.message}`);
        }
    }

    _onNotify({job, status, title, body}) {
        try {
            const notification = new Gio.Notification();
            notification.set_title(title);
            notification.set_body(body);
            notification.set_icon(new Gio.ThemedIcon({name: 'io.github.chrismaille.SaveMe'}));
            notification.set_priority(
                ['error', 'waiting-source', 'waiting-destination', 'needs-auth', 'delete-guard']
                    .includes(status)
                    ? Gio.NotificationPriority.HIGH
                    : Gio.NotificationPriority.NORMAL);
            notification.add_button('Open', 'app.open-settings');
            this.send_notification(`job-${job.id}-${status}`, notification);
        } catch (e) {
            this._logger?.warn(`Cannot send notification: ${e.message}`);
        }
    }

    snapshotJson() {
        const jobs = this._config.listJobs().map(job => ({
            ...job,
            state: this._state.getJobState(job.id),
        }));
        let rcloneInfo;
        try {
            const version = this._rclone.getVersion();
            rcloneInfo = {
                path: this._rclone.binary,
                version: version.text,
            };
        } catch (e) {
            rcloneInfo = {path: this._rclone?.binary || findRclone(), error: e.message};
        }
        return JSON.stringify({
            version: VERSION,
            daemon: {
                pid: getPid(),
                startedAt: this._startedAt,
                rclone: rcloneInfo,
            },
            settings: this._config.settings,
            pausedAll: this._state.pausedAll,
            remotes: this._config.listRemotes(),
            jobs,
            volumes: this._volumes.list(),
        });
    }

    runJob(jobId, dryRun, force) {
        const supervisor = this._manager.get(jobId);
        if (!supervisor)
            throw new Error(`Job not found: ${jobId}`);
        if (supervisor.running)
            throw new Error('Job is already running.');
        const runId = uniqueId('run_');
        this._manager.runJob(jobId, {dryRun, force, runId}).then(run => {
            if (!run)
                this._logger?.warn(`Run ${runId} did not start`);
        }).catch(e => {
            this._logger?.error(`Run ${runId} failed: ${e.message}`);
        });
        return runId;
    }

    cancelJob(jobId) {
        this._manager.cancelJob(jobId);
        this._markDirty();
    }

    pauseJob(jobId, paused) {
        this._manager.pauseJob(jobId, paused);
        this._markDirty();
    }

    setJobEnabled(jobId, enabled) {
        const job = this._config.setJobEnabled(jobId, enabled);
        this._manager.updateJob(jobId, job);
        this._emitSnapshot(true);
    }

    pauseAll(paused) {
        this._manager.pauseAll(paused);
        this._emitSnapshot(true);
    }

    saveJob(payloadJson) {
        const payload = JSON.parse(payloadJson);
        delete payload.state;
        let saved;
        if (payload.id && this._config.getJob(payload.id))
            saved = this._config.updateJob(payload.id, payload);
        else
            saved = this._config.addJob(payload);
        this._manager.addJob(saved);
        this._emitSnapshot(true);
        return JSON.stringify(saved);
    }

    deleteJob(jobId) {
        this._config.removeJob(jobId);
        this._manager.removeJob(jobId);
        this._emitSnapshot(true);
    }

    getRun(jobId, runId) {
        return JSON.stringify(this._state.getRun(jobId, runId) || {});
    }

    getRunLog(jobId, runId) {
        const run = this._state.getRun(jobId, runId);
        if (!run)
            throw new Error(`Run not found: ${runId}`);
        return readTextTail(run.logFile, 800);
    }

    listRuns(jobId, limit) {
        return JSON.stringify(this._state.listRuns(jobId, Number(limit) || 50));
    }

    _resolveJobDestination(job) {
        return job.destination.kind === 'local'
            ? localPathFor(job.destination, this._volumes)
            : remotePathFor(job.destination);
    }

    listVersions(jobId) {
        const job = this._config.getJob(jobId);
        if (!job)
            throw new Error(`Job not found: ${jobId}`);
        if (job.type !== 'backup')
            return JSON.stringify([]);
        const dest = this._resolveJobDestination(job);
        const root = versionsRootFor(job, dest);
        const result = this._rclone.runCapture(['lsf', root, '--dirs-only']);
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
        if (!remote || !this._config.getRemote(remote))
            throw new Error(`Remote not found: ${remote}`);
        const cleanPath = String(path || '').replace(/^\/+|\/+$/g, '');
        const target = cleanPath ? `${remote}:${cleanPath}` : `${remote}:`;
        if (dirsOnly) {
            const result = this._rclone.runCapture(['lsf', target, '--dirs-only']);
            if (result.exitCode === 3)
                return JSON.stringify([]);
            if (!isSuccessExit(result.exitCode))
                throw new Error(result.stderr.trim() || exitCodeMessage(result.exitCode));
            const entries = result.stdout.split('\n')
                .map(line => line.trim().replace(/\/$/, ''))
                .filter(Boolean)
                .map(name => ({name, isDir: true, size: 0, modTime: null}))
                .sort((a, b) => a.name.localeCompare(b.name));
            return JSON.stringify(entries);
        }
        const result = this._rclone.runCapture(['lsjson', target]);
        if (result.exitCode === 3)
            return JSON.stringify([]);
        if (!isSuccessExit(result.exitCode))
            throw new Error(result.stderr.trim() || exitCodeMessage(result.exitCode));
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
        return JSON.stringify(entries);
    }

    listBackup(jobId, version, path, dirsOnly) {
        const job = this._config.getJob(jobId);
        if (!job)
            throw new Error(`Job not found: ${jobId}`);
        if (job.type !== 'backup')
            throw new Error('This job is not a backup job.');
        const dest = this._resolveJobDestination(job);
        let root;
        if (version) {
            if (!validateVersionName(version))
                throw new Error('Invalid version name.');
            root = joinPath(versionsRootFor(job, dest), version);
        } else {
            root = backupCurrentFor(job, dest);
        }
        const cleanPath = String(path || '').replace(/^\/+|\/+$/g, '');
        const target = cleanPath ? joinRclonePath(root, cleanPath) : root;
        if (dirsOnly) {
            const result = this._rclone.runCapture(['lsf', target, '--dirs-only']);
            if (result.exitCode === 3)
                return JSON.stringify([]);
            if (!isSuccessExit(result.exitCode))
                throw new Error(result.stderr.trim() || exitCodeMessage(result.exitCode));
            const entries = result.stdout.split('\n')
                .map(line => line.trim().replace(/\/$/, ''))
                .filter(Boolean)
                .map(name => ({name, isDir: true, size: 0, modTime: null}))
                .sort((a, b) => a.name.localeCompare(b.name));
            return JSON.stringify(entries);
        }
        const result = this._rclone.runCapture(['lsjson', target]);
        if (result.exitCode === 3)
            return JSON.stringify([]);
        if (!isSuccessExit(result.exitCode))
            throw new Error(result.stderr.trim() || exitCodeMessage(result.exitCode));
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
        return JSON.stringify(entries);
    }

    restore(payloadJson) {
        const payload = JSON.parse(payloadJson);
        const job = this._config.getJob(payload.jobId);
        if (!job)
            throw new Error(`Job not found: ${payload.jobId}`);
        if (!payload.target)
            throw new Error('Restore target is required.');
        if (!validateRelativePath(payload.target) || !validateRelativePath(payload.path || ''))
            throw new Error('Invalid restore path.');
        const dest = this._resolveJobDestination(job);
        let source;
        if (payload.version) {
            if (!validateVersionName(payload.version))
                throw new Error('Invalid version name.');
            const root = versionsRootFor(job, dest);
            source = joinPath(root, payload.version);
        } else {
            source = job.type === 'backup' ? backupCurrentFor(job, dest) : dest;
        }
        if (payload.path)
            source = `${String(source).replace(/\/+$/, '')}/${String(payload.path).replace(/^\/+/, '')}`;
        const args = ['copy', source, payload.target, '--create-empty-src-dirs'];
        if (payload.dryRun)
            args.push('--dry-run');
        const result = this._rclone.runCapture(args);
        if (!isSuccessExit(result.exitCode)) {
            throw new Error(result.stderr.trim() ||
                `Restore failed: ${exitCodeMessage(result.exitCode)}`);
        }
        this._emitSnapshot(true);
        return JSON.stringify({ok: true, dryRun: Boolean(payload.dryRun), source});
    }

    beginRemoteAuth(provider, name, optionsJson) {
        const options = optionsJson ? JSON.parse(optionsJson) : {};
        return this._auth.begin(provider, name, options);
    }

    getRemoteAuth(authId) {
        return this._auth.get(authId);
    }

    cancelRemoteAuth(authId) {
        this._auth.cancel(authId);
    }

    deleteRemote(name) {
        const users = this._config.listJobs()
            .filter(job => jobRemoteNames(job).includes(name));
        if (users.length > 0) {
            throw new Error(`Remote ${name} is used by jobs: ` +
                users.map(job => job.name).join(', '));
        }
        const result = this._rclone.configDelete(name);
        if (!isSuccessExit(result.exitCode)) {
            throw new Error(result.stderr.trim() ||
                `Cannot delete remote ${name}: ${exitCodeMessage(result.exitCode)}`);
        }
        this._config.removeRemote(name);
        try {
            Gio.File.new_for_path(this._rclone.configPath).set_attribute_uint32(
                'unix::mode', 0o600, Gio.FileQueryInfoFlags.NONE, null);
        } catch (_) {
            // Best effort.
        }
        this._emitSnapshot(true);
    }

    doctorJson() {
        let rcloneInfo;
        try {
            const version = this._rclone.getVersion();
            rcloneInfo = {
                ok: true,
                path: this._rclone.binary,
                version: version.text,
                minimum: '1.60.0',
                supported: this._rclone.checkVersion('1.60.0'),
            };
        } catch (e) {
            rcloneInfo = {ok: false, error: e.message};
        }
        return JSON.stringify({
            version: VERSION,
            gjs: system.version,
            configDir: configDir(),
            stateDir: stateDir(),
            rclone: rcloneInfo,
            volumes: this._volumes.list(),
            jobs: this._config.listJobs().length,
            remotes: this._config.listRemoteNames(),
            pausedAll: this._state.pausedAll,
        });
    }
});

export function main() {
    const app = new SaveMeDaemonApplication();
    GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, 2, () => {
        app.quit();
        return GLib.SOURCE_REMOVE;
    });
    GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, 15, () => {
        app.quit();
        return GLib.SOURCE_REMOVE;
    });
    return app.run([]);
}
