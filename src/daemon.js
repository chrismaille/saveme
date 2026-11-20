import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';
import GObject from 'gi://GObject';
import system from 'system';
import {ConfigStore} from './adapters/persistence/config-repository.js';
import {StateStore} from './adapters/persistence/state-repository.js';
import {VolumeResolver} from './adapters/gio/volume-catalog.js';
import {
    RcloneTransferEngine as Rclone,
    findRclone,
} from './adapters/rclone/transfer-engine.js';
import {DaemonApi} from './adapters/dbus/api.js';
import {SystemClock} from './adapters/system/clock.js';
import {LogStore} from './adapters/system/log-store.js';
import {IdleMonitor} from './adapters/system/idle-monitor.js';
import {cpuPercent, readProcessMetrics} from './adapters/system/process-metrics.js';
import {readSystemMetrics} from './adapters/system/system-metrics.js';
import {DaemonService} from './application/daemon-service.js';
import {LogService} from './application/log-service.js';
import {createJobRunner, createRestoreService} from './composition/runner.js';
import {JobManager} from './supervisor.js';
import {RemoteAuthManager} from './auth.js';
import {Logger, readTextTail} from './adapters/system/logger.js';
import {DAEMON_INTERFACE} from './dbus.js';
import {
    DAEMON_APP_ID,
    DAEMON_OBJECT_PATH,
    configDir,
    daemonLogFile,
    rcloneConfigFile,
    stateDir,
} from './paths.js';
import {ensureDir, nowIso, uniqueId} from './util.js';

const VERSION = '1.3.4';

function getPid() {
    try {
        const [, bytes] = GLib.file_get_contents('/proc/self/stat');
        return Number(new TextDecoder().decode(bytes).split(' ')[0]);
    } catch (_) {
        return null;
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
        this._restore = null;
        this._manager = null;
        this._service = null;
        this._logStore = null;
        this._logService = null;
        this._logPruneTimer = null;
        this._idleMonitor = null;
        this._processTimer = null;
        this._processMetrics = null;
        this._lastProcessMetrics = null;
        this._processSamples = 0;
        this._processWarned = false;
        this._systemMetrics = null;
        this._lastSystemSample = null;
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
        GLib.set_application_name('SaveMe');
        ensureDir(stateDir(), 0o700);
        this._logger = new Logger({
            name: 'daemon',
            filePath: daemonLogFile(),
            level: 'info',
            echo: true,
        });
        this._logger.info(`SaveMe daemon ${VERSION} starting`, {
            config: configDir(),
            state: stateDir(),
        });
        this._sampleProcess('startup');
        this._processTimer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, 5, () => {
                this._sampleProcess('periodic');
                return GLib.SOURCE_CONTINUE;
            });

        this._config = new ConfigStore({logger: this._logger});
        this._config.load();
        this._state = new StateStore({logger: this._logger});
        this._state.load();
        this._state.resetRunningJobs();

        this._logStore = new LogStore();
        this._logService = new LogService({
            store: this._logStore,
            getSettings: () => this._config.settings,
            logger: this._logger,
            clock: new SystemClock(),
            onClearDaemon: () => this._logger.clear(),
            onCloseDaemonLog: () => this._logger.close(),
        });

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

        this._runner = createJobRunner({
            rclone: this._rclone,
            volumes: this._volumes,
            logger: this._logger,
            state: this._state,
            getSettings: () => this._config.settings,
        });
        this._restore = createRestoreService({rclone: this._rclone});
        this._idleMonitor = new IdleMonitor();
        this._manager = new JobManager({
            config: this._config,
            state: this._state,
            runner: this._runner,
            logger: this._logger,
            clock: new SystemClock(),
            isIdle: () => this._idleMonitor.isIdle(),
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
        this._service = new DaemonService({
            config: this._config,
            state: this._state,
            manager: this._manager,
            restore: this._restore,
            auth: this._auth,
            transfer: this._rclone,
            volumes: this._volumes,
            logger: this._logger,
            logs: this._logService,
            processMetrics: () => this._processMetrics,
            systemMetrics: () => this._systemMetrics,
            startedAt: this._startedAt,
            idFactory: prefix => uniqueId(prefix),
            getPid,
            readTextTail,
            findRclone,
            secureFile: path => {
                try {
                    Gio.File.new_for_path(path).set_attribute_uint32(
                        'unix::mode', 0o600, Gio.FileQueryInfoFlags.NONE, null);
                } catch (_) {
                    // Best effort.
                }
            },
            environment: {
                version: VERSION,
                gjs: system.version,
                configDir: configDir(),
                stateDir: stateDir(),
            },
            onSnapshot: force => this._emitSnapshot(force),
        });

        this._api = new DaemonApi({service: this._service, quit: () => this.quit()});
        this._exportDbus();
        this._setupActions();
        this._setupVolumes();
        this._setupNetwork();
        this._setupLogind();
        this._snapshotTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._emitSnapshot();
            return GLib.SOURCE_CONTINUE;
        });
        this._logPruneTimer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, 6 * 3600, () => {
                try {
                    this._logService?.prune();
                } catch (e) {
                    this._logger?.warn(`Log cleanup failed: ${e.message}`);
                }
                return GLib.SOURCE_CONTINUE;
            });
        try {
            this._logService?.prune();
        } catch (e) {
            this._logger?.warn(`Initial log cleanup failed: ${e.message}`);
        }
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
        if (this._logPruneTimer) {
            GLib.source_remove(this._logPruneTimer);
            this._logPruneTimer = null;
        }
        if (this._processTimer) {
            GLib.source_remove(this._processTimer);
            this._processTimer = null;
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

    _sampleProcess(reason = 'periodic') {
        const current = readProcessMetrics();
        if (!current)
            return null;
        const cpu = cpuPercent(this._lastProcessMetrics, current);
        this._lastProcessMetrics = current;
        this._systemMetrics = readSystemMetrics({
            previous: this._lastSystemSample,
        });
        this._lastSystemSample = this._systemMetrics?.cpu || null;
        this._processSamples++;
        const metrics = {
            rssBytes: Number(current.rssBytes) || 0,
            peakRssBytes: Number(current.peakRssBytes) || 0,
            cpuPercent: cpu,
            sampledAt: new Date(current.sampledAtMs).toISOString(),
            samples: this._processSamples,
        };
        this._processMetrics = metrics;
        const rssMiB = metrics.rssBytes / (1024 * 1024);
        if (reason === 'startup' || this._processSamples % 12 === 0 || rssMiB > 256) {
            this._logger?.info('Daemon performance sample', {
                reason,
                rssMiB: Number(rssMiB.toFixed(1)),
                peakMiB: Number((metrics.peakRssBytes / (1024 * 1024)).toFixed(1)),
                cpuPercent: Number(cpu.toFixed(1)),
                systemCpuPercent: this._systemMetrics
                    ? Number(this._systemMetrics.cpuPercent.toFixed(1)) : null,
                systemMemoryUsedMiB: this._systemMetrics
                    ? Number((this._systemMetrics.memory.usedBytes / (1024 * 1024)).toFixed(1))
                    : null,
                samples: metrics.samples,
            });
        }
        if (rssMiB > 256) {
            if (!this._processWarned) {
                this._logger?.warn('Daemon performance warning', {
                    rssMiB: Number(rssMiB.toFixed(1)),
                    peakMiB: Number((metrics.peakRssBytes / (1024 * 1024)).toFixed(1)),
                });
                this._processWarned = true;
            }
        } else if (rssMiB < 240 && this._processWarned) {
            this._logger?.info('Daemon memory back under budget', {
                rssMiB: Number(rssMiB.toFixed(1)),
            });
            this._processWarned = false;
        }
        return metrics;
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
        const json = this._service.snapshotJson();
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
