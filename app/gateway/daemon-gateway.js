import {DaemonClient} from '../daemon-client.js';

/**
 * Application gateway: the only app-layer object that knows about D-Bus.
 * Controllers and pages receive this object and never import DaemonClient.
 */
export class DaemonGateway {
    constructor({client = new DaemonClient()} = {}) {
        this.client = client;
    }

    close() {
        this.client.close();
    }

    onSnapshot(callback) {
        return this.client.onSnapshot(callback);
    }

    onRemoteAuth(callback) {
        return this.client.onRemoteAuth(callback);
    }

    getSnapshot() {
        return this.client.getSnapshot();
    }

    runJob(jobId, dryRun = false, force = false) {
        return this.client.runJob(jobId, dryRun, force);
    }

    playJob(jobId) {
        return this.client.playJob(jobId);
    }

    cancelJob(jobId) {
        return this.client.cancelJob(jobId);
    }

    pauseJob(jobId, paused) {
        return this.client.pauseJob(jobId, paused);
    }

    setJobEnabled(jobId, enabled) {
        return this.client.setJobEnabled(jobId, enabled);
    }

    pauseAll(paused) {
        return this.client.pauseAll(paused);
    }

    setJobOptions(jobId, options) {
        return this.client.setJobOptions(jobId, options);
    }

    saveJob(job) {
        return this.client.saveJob(job);
    }

    importJob(job) {
        return this.client.importJob(job);
    }

    inspectBackup(path) {
        return this.client.inspectBackup(path);
    }

    remoteWebUrl(remote, path) {
        return this.client.remoteWebUrl(remote, path);
    }

    jobSize(jobId) {
        return this.client.jobSize(jobId);
    }

    deleteJob(jobId, deleteData = false) {
        return this.client.deleteJob(jobId, deleteData);
    }

    getRun(jobId, runId) {
        return this.client.getRun(jobId, runId);
    }

    getRunLog(jobId, runId) {
        return this.client.getRunLog(jobId, runId);
    }

    listRuns(jobId, limit = 50) {
        return this.client.listRuns(jobId, limit);
    }

    listVersions(jobId) {
        return this.client.listVersions(jobId);
    }

    listRemote(remote, path = '', dirsOnly = false) {
        return this.client.listRemote(remote, path, dirsOnly);
    }

    listBackup(jobId, version = '', path = '', dirsOnly = false) {
        return this.client.listBackup(jobId, version, path, dirsOnly);
    }

    restore(payload) {
        return this.client.restore(payload);
    }

    beginRemoteAuth(provider, name, options = {}) {
        return this.client.beginRemoteAuth(provider, name, options);
    }

    getRemoteAuth(authId) {
        return this.client.getRemoteAuth(authId);
    }

    cancelRemoteAuth(authId) {
        return this.client.cancelRemoteAuth(authId);
    }

    deleteRemote(name) {
        return this.client.deleteRemote(name);
    }

    createRemote(remote) {
        return this.client.createRemote(remote);
    }

    doctor() {
        return this.client.doctor();
    }

    getLogsInfo() {
        return this.client.getLogsInfo();
    }

    pruneLogs() {
        return this.client.pruneLogs();
    }

    clearLogs(scope) {
        return this.client.clearLogs(scope);
    }

    sanitizeLogs() {
        return this.client.sanitizeLogs();
    }

    updateSettings(patch) {
        return this.client.updateSettings(patch);
    }
}
