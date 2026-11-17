export class DaemonApi {
    constructor({service, quit = null}) {
        this.service = service;
        this.quit = quit;
    }

    GetSnapshot() {
        return this.service.snapshotJson();
    }

    RunJob(jobId, dryRun, force) {
        return this.service.runJob(jobId, Boolean(dryRun), Boolean(force));
    }

    PlayJob(jobId) {
        return this.service.playJob(jobId);
    }

    CancelJob(jobId) {
        this.service.cancelJob(jobId);
    }

    PauseJob(jobId, paused) {
        this.service.pauseJob(jobId, Boolean(paused));
    }

    SetJobEnabled(jobId, enabled) {
        this.service.setJobEnabled(jobId, Boolean(enabled));
    }

    PauseAll(paused) {
        this.service.pauseAll(Boolean(paused));
    }

    SaveJob(payloadJson) {
        return this.service.saveJob(payloadJson);
    }

    ImportJob(payloadJson) {
        return this.service.importJob(payloadJson);
    }

    InspectBackup(path) {
        return this.service.inspectBackup(path);
    }

    RemoteWebUrl(remote, path) {
        return this.service.remoteWebUrl(remote, path);
    }

    DeleteJob(jobId, deleteData) {
        this.service.deleteJob(jobId, Boolean(deleteData));
    }

    GetRun(jobId, runId) {
        return this.service.getRun(jobId, runId);
    }

    GetRunLog(jobId, runId) {
        return this.service.getRunLog(jobId, runId);
    }

    ListRuns(jobId, limit) {
        return this.service.listRuns(jobId, limit);
    }

    ListVersions(jobId) {
        return this.service.listVersions(jobId);
    }

    ListRemote(remote, path, dirsOnly) {
        return this.service.listRemote(remote, path, Boolean(dirsOnly));
    }

    ListBackup(jobId, version, path, dirsOnly) {
        return this.service.listBackup(jobId, version, path, Boolean(dirsOnly));
    }

    Restore(payloadJson) {
        return this.service.restore(payloadJson);
    }

    BeginRemoteAuth(provider, name, optionsJson) {
        return this.service.beginRemoteAuth(provider, name, optionsJson);
    }

    GetRemoteAuth(authId) {
        return this.service.getRemoteAuth(authId);
    }

    CancelRemoteAuth(authId) {
        this.service.cancelRemoteAuth(authId);
    }

    DeleteRemote(name) {
        this.service.deleteRemote(name);
    }

    Doctor() {
        return this.service.doctorJson();
    }

    GetLogsInfo() {
        return this.service.logsInfoJson();
    }

    PruneLogs() {
        return this.service.pruneLogsJson();
    }

    ClearLogs(scope) {
        return this.service.clearLogsJson(scope);
    }

    SanitizeLogs() {
        return this.service.sanitizeLogsJson();
    }

    UpdateSettings(payloadJson) {
        return this.service.updateSettingsJson(payloadJson);
    }

    Quit() {
        this.quit?.();
    }
}
