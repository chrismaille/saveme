import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const DAEMON_BUS_NAME = 'io.github.chrismaille.SaveMe.Daemon';
export const DAEMON_OBJECT_PATH = '/io/github/chrismaille/SaveMe/Daemon';
export const DAEMON_INTERFACE = 'io.github.chrismaille.SaveMe.Daemon';

export class SaveMeDaemonClient {
    constructor({bus = null, onSnapshot = null, onError = null, onAfterCall = null} = {}) {
        this.onSnapshot = onSnapshot;
        this.onError = onError;
        this.onAfterCall = onAfterCall;
        this._bus = bus || Gio.bus_get_sync(Gio.BusType.SESSION, null);
        this._signalId = 0;
        this._snapshotJson = null;
    }

    connect() {
        this._signalId = this._bus.signal_subscribe(
            DAEMON_BUS_NAME,
            DAEMON_INTERFACE,
            'SnapshotChanged',
            DAEMON_OBJECT_PATH,
            null,
            Gio.DBusSignalFlags.NONE,
            (_connection, _sender, _path, _iface, _signal, params) => {
                try {
                    const [json] = params.deepUnpack();
                    this._applySnapshot(json);
                } catch (e) {
                    this.onError?.(e.message);
                }
            });
        this.refresh();
    }

    disconnect() {
        if (this._signalId) {
            try {
                this._bus.signal_unsubscribe(this._signalId);
            } catch (_) {
                // Ignore.
            }
            this._signalId = 0;
        }
        this._snapshotJson = null;
    }

    invalidateSnapshot() {
        this._snapshotJson = null;
    }

    _applySnapshot(json) {
        if (json === this._snapshotJson)
            return;
        this._snapshotJson = json;
        this.onSnapshot?.(json);
    }

    _call(method, params, callback = null) {
        if (!this._bus)
            return;
        this._bus.call(
            DAEMON_BUS_NAME,
            DAEMON_OBJECT_PATH,
            DAEMON_INTERFACE,
            method,
            params,
            null,
            Gio.DBusCallFlags.NONE,
            5000,
            null,
            (connection, result) => {
                try {
                    const reply = connection.call_finish(result);
                    callback?.(reply);
                    this.onAfterCall?.();
                } catch (e) {
                    this.onError?.(e.message);
                }
            });
    }

    refresh() {
        this._call('GetSnapshot', null, reply => {
            const [json] = reply.deepUnpack();
            this._applySnapshot(json);
        });
    }

    runJob(jobId) {
        this._call('RunJob', new GLib.Variant('(sbb)', [jobId, false, false]));
    }

    playJob(jobId) {
        this._call('PlayJob', new GLib.Variant('(s)', [jobId]));
    }

    cancelJob(jobId) {
        this._call('CancelJob', new GLib.Variant('(s)', [jobId]));
    }

    pauseJob(jobId, paused) {
        this._call('PauseJob', new GLib.Variant('(sb)', [jobId, paused]));
    }

    pauseAll(paused) {
        this._call('PauseAll', new GLib.Variant('(b)', [paused]));
    }
}
