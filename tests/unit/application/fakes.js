import {RunExecutor} from '../../../src/application/run-executor.js';
import {SyncService} from '../../../src/application/sync-service.js';
import {BackupService} from '../../../src/application/backup-service.js';
import {RunCoordinator} from '../../../src/application/run-coordinator.js';
import {emptyStats} from '../../../src/domain/rclone-log.js';
import {jobDefaults} from '../../../src/domain/job.js';

export class FakeFileSystem {
    constructor() {
        this.nodes = new Map();
        this.writes = [];
        this.removed = [];
        this.topLevel = new Map();
    }

    addDir(path) {
        this.nodes.set(path, 'directory');
    }

    addFile(path) {
        this.nodes.set(path, 'file');
    }

    exists(path) {
        return this.nodes.has(path);
    }

    queryType(path) {
        return this.nodes.get(path) ?? null;
    }

    isDirectory(path) {
        return this.queryType(path) === 'directory';
    }

    topLevelEntryCount(path) {
        return this.topLevel.get(path) ?? 0;
    }

    relativePath(root, path) {
        const base = String(root).replace(/\/+$/, '');
        const value = String(path).replace(/\/+$/, '');
        if (value === base)
            return '';
        if (!value.startsWith(`${base}/`))
            return null;
        return value.slice(base.length + 1);
    }

    joinPath(...parts) {
        return parts.filter(part => part !== undefined && part !== null && part !== '')
            .join('/')
            .replace(/\/+/g, '/');
    }

    ensureDir(path) {
        this.nodes.set(path, 'directory');
    }

    writeText(path, text, mode) {
        this.writes.push({path, text, mode});
        this.nodes.set(path, 'file');
    }

    removeIfExists(path) {
        this.removed.push(path);
        this.nodes.delete(path);
    }
}

export class FakeTransfer {
    constructor() {
        this.runs = [];
        this.captures = [];
        this.sizes = new Map();
        this.handler = null;
        this.captureHandler = null;
    }

    async run(args, options = {}) {
        this.runs.push({args, options});
        if (this.handler)
            return this.handler(args, options);
        return {
            exitCode: 0,
            stats: emptyStats(),
            lastError: null,
            cancelled: false,
            argv: ['rclone', ...args],
        };
    }

    runCapture(args) {
        this.captures.push(args);
        if (this.captureHandler)
            return this.captureHandler(args);
        return {ok: true, exitCode: 0, stdout: '', stderr: '', argv: ['rclone', ...args]};
    }

    size(path, {fastList = false} = {}) {
        this.lastSize = {path, fastList};
        return this.sizes.get(path) ?? {count: 0, bytes: 0};
    }

    async sizeAsync(path, {fastList = false, cancellable = null} = {}) {
        this.lastSize = {path, fastList, cancellable};
        return this.sizes.get(path) ?? {count: 0, bytes: 0};
    }
}

export class FakeClock {
    constructor(ms = new Date(2026, 0, 2, 3, 4, 5).getTime()) {
        this.ms = ms;
    }

    nowMs() {
        return this.ms;
    }

    nowIso() {
        return new Date(this.ms).toISOString();
    }

    newDate() {
        return new Date(this.ms);
    }

    advance(ms) {
        this.ms += ms;
    }
}

export class FakeLogger {
    constructor(name = 'test', filePath = null, sink = null) {
        this.name = name;
        this.filePath = filePath;
        this.sink = sink ?? [];
    }

    _write(level, message, fields = null) {
        this.sink.push({level, name: this.name, message, fields});
    }

    debug(message, fields = null) {
        this._write('debug', message, fields);
    }

    info(message, fields = null) {
        this._write('info', message, fields);
    }

    warn(message, fields = null) {
        this._write('warn', message, fields);
    }

    error(message, fields = null) {
        this._write('error', message, fields);
    }

    child(name, filePath = null) {
        return new FakeLogger(`${this.name}/${name}`, filePath, this.sink);
    }

    close() {}
}

export class FakeState {
    constructor() {
        this.jobs = new Map();
    }

    getJobState(jobId) {
        return {
            status: 'idle',
            message: '',
            paused: false,
            progress: null,
            lastSourceFileCount: 0,
            ...(this.jobs.get(jobId) || {}),
        };
    }

    setJobState(jobId, patch) {
        const next = {...this.getJobState(jobId), ...patch};
        this.jobs.set(jobId, next);
        return next;
    }

    updateProgress(jobId, progress) {
        return this.setJobState(jobId, {progress});
    }
}

export class FakeRunRepository {
    constructor() {
        this.runs = [];
    }

    recordRun(run) {
        this.runs.push(run);
        return run;
    }

    getRun(jobId, runId) {
        return this.runs.find(run => run.jobId === jobId && run.id === runId) ?? null;
    }

    listRuns(jobId) {
        return this.runs.filter(run => run.jobId === jobId);
    }
}

export class FakeRawLogFactory {
    constructor() {
        this.logs = [];
    }

    create(path) {
        const log = {
            path,
            lines: [],
            write(line) {
                log.lines.push(line);
            },
            close() {},
        };
        this.logs.push(log);
        return log;
    }
}

export class FakePaths {
    filtersDir() {
        return '/tmp/filters';
    }

    logsDir(jobId = null) {
        return jobId ? `/tmp/logs/${jobId}` : '/tmp/logs';
    }

    tmpDir() {
        return '/tmp/tmp';
    }

    join(...parts) {
        return parts.filter(Boolean).join('/').replace(/\/+/g, '/');
    }
}

export function makeJob(type = 'sync', overrides = {}) {
    return jobDefaults({
        name: 'Test',
        type,
        source: {kind: 'local', path: '/src'},
        destination: {kind: 'local', path: '/dst'},
        trigger: {mode: 'manual'},
        backup: {retentionDays: 0},
        ...overrides,
    }, {
        idFactory: () => 'job_test',
        now: () => '2026-01-02T03:04:05.000Z',
    });
}

export function makeExecutor({
    transfer = new FakeTransfer(),
    files = new FakeFileSystem(),
    logger = new FakeLogger(),
    state = new FakeState(),
    clock = new FakeClock(),
    paths = new FakePaths(),
    rawLogFactory = new FakeRawLogFactory(),
} = {}) {
    const runRepository = new FakeRunRepository();
    let counter = 0;
    const executor = new RunExecutor({
        transfer,
        files,
        logger,
        state,
        runRepository,
        clock,
        paths,
        rawLogFactory,
        idFactory: prefix => `${prefix}${++counter}`,
    });
    return {executor, transfer, files, logger, state, clock, paths, rawLogFactory, runRepository};
}

export function makeServices(options = {}) {
    const context = makeExecutor(options);
    const sync = new SyncService({
        executor: context.executor,
        files: context.files,
        volumes: null,
    });
    const backup = new BackupService({
        executor: context.executor,
        files: context.files,
        volumes: null,
    });
    const coordinator = new RunCoordinator({sync, backup});
    return {...context, sync, backup, coordinator};
}
