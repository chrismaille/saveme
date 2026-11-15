import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {logsDir, runsDir, stateFile} from './paths.js';
import {atomicWriteJson, ensureDir, mergeDeep, readJson} from './util.js';

export const STATE_VERSION = 1;

function defaultState() {
    return {
        version: STATE_VERSION,
        pausedAll: false,
        jobs: {},
    };
}

function defaultJobState() {
    return {
        status: 'idle',
        message: '',
        paused: false,
        stopped: false,
        interrupted: false,
        lastRunId: null,
        lastResult: null,
        lastRunAt: null,
        lastFinishedAt: null,
        nextRunAt: null,
        progress: null,
        lastStats: null,
        lastSourceFileCount: 0,
        consecutiveErrors: 0,
    };
}

export class StateStore {
    constructor({path = stateFile(), logger = null} = {}) {
        this.path = path;
        this.logger = logger;
        this.data = null;
    }

    load() {
        ensureDir(GLib.path_get_dirname(this.path), 0o700);
        if (!GLib.file_test(this.path, GLib.FileTest.EXISTS)) {
            this.data = defaultState();
            this.save();
            return this.data;
        }
        try {
            const raw = readJson(this.path, defaultState());
            this.data = mergeDeep(defaultState(), raw);
        } catch (e) {
            this.logger?.warn(`Cannot read state: ${e.message}`);
            this.data = defaultState();
        }
        return this.data;
    }

    save() {
        if (!this.data)
            throw new Error('State not loaded');
        ensureDir(GLib.path_get_dirname(this.path), 0o700);
        atomicWriteJson(this.path, this.data, 0o600);
    }

    get pausedAll() {
        return Boolean(this.data.pausedAll);
    }

    setPausedAll(value) {
        this.data.pausedAll = Boolean(value);
        this.save();
    }

    getJobState(jobId) {
        const existing = this.data.jobs[jobId] || {};
        return mergeDeep(defaultJobState(), existing);
    }

    setJobState(jobId, patch) {
        const current = this.getJobState(jobId);
        this.data.jobs[jobId] = mergeDeep(current, patch);
        this.save();
        return this.getJobState(jobId);
    }

    updateProgress(jobId, progress) {
        return this.setJobState(jobId, {progress});
    }

    resetRunningJobs() {
        let changed = false;
        for (const [jobId, jobState] of Object.entries(this.data.jobs)) {
            if (jobState.status === 'running') {
                this.data.jobs[jobId] = mergeDeep(jobState, {
                    status: 'error',
                    message: 'Daemon restarted during the run.',
                    interrupted: true,
                    progress: null,
                });
                changed = true;
            }
        }
        if (changed)
            this.save();
    }

    recordRun(run) {
        ensureDir(runsDir(run.jobId), 0o700);
        const runPath = GLib.build_filenamev([runsDir(run.jobId), `${run.id}.json`]);
        atomicWriteJson(runPath, run, 0o600);
        const patch = {
            lastRunId: run.id,
            lastResult: run.result,
            lastRunAt: run.startedAt,
            lastFinishedAt: run.finishedAt,
            message: run.message || '',
            interrupted: false,
            progress: null,
            lastStats: {
                files: Number(run.stats?.transfers || 0),
                totalFiles: Number(run.stats?.totalTransfers || 0),
                bytes: Number(run.stats?.bytes || 0),
                totalBytes: Number(run.stats?.totalBytes || 0),
                deletes: Number(run.stats?.deletes || 0),
                errors: Number(run.stats?.errors || 0),
                result: run.result,
                finishedAt: run.finishedAt,
            },
        };
        if (run.result === 'success' || run.result === 'noop')
            patch.consecutiveErrors = 0;
        else if (run.result === 'error' && !run.dryRun)
            patch.consecutiveErrors = this.getJobState(run.jobId).consecutiveErrors + 1;
        if (Number.isFinite(run.sourceFileCount))
            patch.lastSourceFileCount = run.sourceFileCount;
        if (run.dryRun)
            patch.status = 'idle';
        else if (run.result === 'error')
            patch.status = 'error';
        else if (run.result === 'cancelled')
            patch.status = 'paused';
        else
            patch.status = 'idle';
        this.setJobState(run.jobId, patch);
        this.cleanupRuns(run.jobId);
        return run;
    }

    listRuns(jobId, limit = 50) {
        const dir = runsDir(jobId);
        if (!GLib.file_test(dir, GLib.FileTest.IS_DIR))
            return [];
        const file = Gio.File.new_for_path(dir);
        const enumerator = file.enumerate_children('standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE, null);
        const runs = [];
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            if (!info.get_name().endsWith('.json'))
                continue;
            try {
                runs.push(readJson(GLib.build_filenamev([dir, info.get_name()])));
            } catch (e) {
                this.logger?.warn(`Cannot read run ${info.get_name()}: ${e.message}`);
            }
        }
        enumerator.close(null);
        runs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
        return runs.slice(0, limit);
    }

    getRun(jobId, runId) {
        return readJson(GLib.build_filenamev([runsDir(jobId), `${runId}.json`]), null);
    }

    cleanupRuns(jobId, {keep = 50, maxAgeDays = 30} = {}) {
        const dir = runsDir(jobId);
        if (!GLib.file_test(dir, GLib.FileTest.IS_DIR))
            return;
        const runs = this.listRuns(jobId, 10000);
        const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
        const toDelete = runs.slice(keep).concat(
            runs.filter(run => {
                const time = Date.parse(run.startedAt);
                return Number.isFinite(time) && time < cutoff;
            }));
        const seen = new Set();
        for (const run of toDelete) {
            if (seen.has(run.id))
                continue;
            seen.add(run.id);
            const logPaths = [
                GLib.build_filenamev([logsDir(jobId), `${run.id}.log`]),
                GLib.build_filenamev([logsDir(jobId), `${run.id}.log.1`]),
                GLib.build_filenamev([logsDir(jobId), `${run.id}.rclone.jsonl`]),
                GLib.build_filenamev([logsDir(jobId), `${run.id}.rclone.jsonl.1`]),
            ];
            for (const path of [
                GLib.build_filenamev([runsDir(jobId), `${run.id}.json`]),
                ...logPaths,
            ]) {
                const file = Gio.File.new_for_path(path);
                if (file.query_exists(null))
                    file.delete(null);
            }
        }
    }

    setStatus(jobId, status, message = '') {
        return this.setJobState(jobId, {status, message});
    }
}
