export class StateRunRepository {
    constructor({state}) {
        this.state = state;
    }

    recordRun(run) {
        return this.state.recordRun(run);
    }

    getRun(jobId, runId) {
        return this.state.getRun(jobId, runId);
    }

    listRuns(jobId, limit) {
        return this.state.listRuns(jobId, limit);
    }
}
