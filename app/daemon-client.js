import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const DAEMON_BUS_NAME = 'io.github.chrismaille.SaveMe.Daemon';
export const DAEMON_OBJECT_PATH = '/io/github/chrismaille/SaveMe/Daemon';
export const DAEMON_INTERFACE = 'io.github.chrismaille.SaveMe.Daemon';

export class DaemonClient {
    constructor() {
        this._bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
        this._snapshotListeners = new Set();
        this._authListeners = new Set();
        this._snapshotId = this._bus.signal_subscribe(
            DAEMON_BUS_NAME,
            DAEMON_INTERFACE,
            'SnapshotChanged',
            DAEMON_OBJECT_PATH,
            null,
            Gio.DBusSignalFlags.NONE,
            (_connection, _sender, _path, _iface, _signal, params) => {
                try {
                    const [json] = params.deepUnpack();
                    for (const listener of this._snapshotListeners)
                        listener(json);
                } catch (_) {
                    // Ignore malformed signals.
                }
            });
        this._authId = this._bus.signal_subscribe(
            DAEMON_BUS_NAME,
            DAEMON_INTERFACE,
            'RemoteAuthChanged',
            DAEMON_OBJECT_PATH,
            null,
            Gio.DBusSignalFlags.NONE,
            (_connection, _sender, _path, _iface, _signal, params) => {
                try {
                    const [authId, json] = params.deepUnpack();
                    for (const listener of this._authListeners)
                        listener(authId, json);
                } catch (_) {
                    // Ignore malformed signals.
                }
            });
    }

    close() {
        if (this._snapshotId)
            this._bus.signal_unsubscribe(this._snapshotId);
        if (this._authId)
            this._bus.signal_unsubscribe(this._authId);
        this._snapshotId = 0;
        this._authId = 0;
        this._snapshotListeners.clear();
        this._authListeners.clear();
    }

    onSnapshot(callback) {
        this._snapshotListeners.add(callback);
        return () => this._snapshotListeners.delete(callback);
    }

    onRemoteAuth(callback) {
        this._authListeners.add(callback);
        return () => this._authListeners.delete(callback);
    }

    _call(method, params = null, timeout = 10_000) {
        return new Promise((resolve, reject) => {
            this._bus.call(
                DAEMON_BUS_NAME,
                DAEMON_OBJECT_PATH,
                DAEMON_INTERFACE,
                method,
                params,
                null,
                Gio.DBusCallFlags.NONE,
                timeout,
                null,
                (connection, result) => {
                    try {
                        resolve(connection.call_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    async getSnapshot() {
        const reply = await this._call('GetSnapshot');
        return JSON.parse(reply.deepUnpack()[0]);
    }

    async runJob(jobId, dryRun = false, force = false) {
        const reply = await this._call('RunJob',
            new GLib.Variant('(sbb)', [jobId, dryRun, force]));
        return reply.deepUnpack()[0];
    }

    async cancelJob(jobId) {
        await this._call('CancelJob', new GLib.Variant('(s)', [jobId]));
    }

    async pauseJob(jobId, paused) {
        await this._call('PauseJob', new GLib.Variant('(sb)', [jobId, paused]));
    }

    async setJobEnabled(jobId, enabled) {
        await this._call('SetJobEnabled', new GLib.Variant('(sb)', [jobId, enabled]));
    }

    async pauseAll(paused) {
        await this._call('PauseAll', new GLib.Variant('(b)', [paused]));
    }

    async saveJob(job) {
        const reply = await this._call('SaveJob',
            new GLib.Variant('(s)', [JSON.stringify(job)]));
        return JSON.parse(reply.deepUnpack()[0]);
    }

    async deleteJob(jobId) {
        await this._call('DeleteJob', new GLib.Variant('(s)', [jobId]));
    }

    async getRun(jobId, runId) {
        const reply = await this._call('GetRun',
            new GLib.Variant('(ss)', [jobId, runId]));
        return JSON.parse(reply.deepUnpack()[0]);
    }

    async getRunLog(jobId, runId) {
        const reply = await this._call('GetRunLog',
            new GLib.Variant('(ss)', [jobId, runId]));
        return reply.deepUnpack()[0];
    }

    async listRuns(jobId, limit = 50) {
        const reply = await this._call('ListRuns',
            new GLib.Variant('(su)', [jobId, limit]));
        return JSON.parse(reply.deepUnpack()[0]);
    }

    async listVersions(jobId) {
        const reply = await this._call('ListVersions',
            new GLib.Variant('(s)', [jobId]), 60_000);
        return JSON.parse(reply.deepUnpack()[0]);
    }

    async listRemote(remote, path = '', dirsOnly = false) {
        const reply = await this._call('ListRemote',
            new GLib.Variant('(ssb)', [remote, path, dirsOnly]), 60_000);
        return JSON.parse(reply.deepUnpack()[0]);
    }

    async listBackup(jobId, version = '', path = '', dirsOnly = false) {
        const reply = await this._call('ListBackup',
            new GLib.Variant('(sssb)', [jobId, version, path, dirsOnly]), 60_000);
        return JSON.parse(reply.deepUnpack()[0]);
    }

    async restore(payload) {
        const reply = await this._call('Restore',
            new GLib.Variant('(s)', [JSON.stringify(payload)]), 300_000);
        return JSON.parse(reply.deepUnpack()[0]);
    }

    async beginRemoteAuth(provider, name, options = {}) {
        const reply = await this._call('BeginRemoteAuth',
            new GLib.Variant('(sss)', [provider, name, JSON.stringify(options)]));
        return reply.deepUnpack()[0];
    }

    async getRemoteAuth(authId) {
        const reply = await this._call('GetRemoteAuth',
            new GLib.Variant('(s)', [authId]));
        return JSON.parse(reply.deepUnpack()[0]);
    }

    async cancelRemoteAuth(authId) {
        await this._call('CancelRemoteAuth', new GLib.Variant('(s)', [authId]));
    }

    async deleteRemote(name) {
        await this._call('DeleteRemote', new GLib.Variant('(s)', [name]));
    }

    async doctor() {
        const reply = await this._call('Doctor', null, 30_000);
        return JSON.parse(reply.deepUnpack()[0]);
    }

    async getLogsInfo() {
        const reply = await this._call('GetLogsInfo');
        return JSON.parse(reply.deepUnpack()[0]);
    }

    async pruneLogs() {
        const reply = await this._call('PruneLogs', null, 60_000);
        return JSON.parse(reply.deepUnpack()[0]);
    }

    async clearLogs(scope) {
        const reply = await this._call('ClearLogs',
            new GLib.Variant('(s)', [scope]), 60_000);
        return JSON.parse(reply.deepUnpack()[0]);
    }

    async sanitizeLogs() {
        const reply = await this._call('SanitizeLogs', null, 60_000);
        return JSON.parse(reply.deepUnpack()[0]);
    }

    async updateSettings(patch) {
        const reply = await this._call('UpdateSettings',
            new GLib.Variant('(s)', [JSON.stringify(patch)]));
        return JSON.parse(reply.deepUnpack()[0]);
    }
}
