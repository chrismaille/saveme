import {DaemonService} from '../../../src/application/daemon-service.js';
import {assert, assertEqual, assertThrows, suite, test} from '../../harness.js';

class FakeConfig {
    constructor() {
        this.settings = {maxConcurrentJobs: 1};
        this.jobs = [];
        this.remotes = [{name: 'drive', type: 'drive'}];
    }
    listJobs() { return this.jobs; }
    getJob(id) { return this.jobs.find(job => job.id === id) || null; }
    getRemote(name) { return this.remotes.find(remote => remote.name === name) || null; }
    listRemotes() { return this.remotes; }
    listRemoteNames() { return this.remotes.map(remote => remote.name); }
    setJobEnabled(id, enabled) {
        const job = this.getJob(id);
        job.enabled = enabled;
        return job;
    }
    addJob(job) { this.jobs.push(job); return job; }
    updateJob(id, patch) {
        const job = this.getJob(id);
        Object.assign(job, patch);
        return job;
    }
    removeJob(id) { this.jobs = this.jobs.filter(job => job.id !== id); }
    addRemote(remote) { this.remotes.push(remote); return remote; }
    updateRemote(name, patch) {
        const remote = this.getRemote(name);
        Object.assign(remote, patch);
        return remote;
    }
    removeRemote(name) { this.remotes = this.remotes.filter(remote => remote.name !== name); }
    updateSettings(patch) {
        Object.assign(this.settings, patch);
        return this.settings;
    }
}

class FakeState {
    constructor() {
        this.pausedAll = false;
        this.jobs = new Map();
        this.runs = new Map();
    }
    getJobState(id) { return this.jobs.get(id) || {status: 'idle'}; }
    getRun(jobId, runId) { return this.runs.get(`${jobId}:${runId}`) || null; }
    listRuns() { return [...this.runs.values()]; }
}

class FakeManager {
    constructor() {
        this.supervisors = new Map();
        this.calls = [];
        this.running = false;
    }
    get(id) { return this.supervisors.get(id) || null; }
    addSupervisor(id) { this.supervisors.set(id, {id, running: this.running}); }
    async runJob(id, options) { this.calls.push(['runJob', id, options]); return {id: 'run'}; }
    async playJob(id, options) { this.calls.push(['playJob', id, options]); return {id: 'run'}; }
    cancelJob(id) { this.calls.push(['cancelJob', id]); }
    pauseJob(id, paused) { this.calls.push(['pauseJob', id, paused]); }
    updateJob(id, job) { this.calls.push(['updateJob', id, job]); }
    updateJobOptions(id, options) { this.calls.push(['updateJobOptions', id, options]); }
    addJob(job) { this.calls.push(['addJob', job]); }
    removeJob(id) { this.calls.push(['removeJob', id]); }
    pauseAll(paused) { this.calls.push(['pauseAll', paused]); }
    setConcurrency(limit) { this.calls.push(['setConcurrency', limit]); }
    startAll() { this.calls.push(['startAll']); }
}

class FakeTransfer {
    constructor() {
        this.binary = '/usr/bin/rclone';
        this.configPath = '/tmp/rclone.conf';
        this.version = {text: '1.76.0'};
        this.captures = [];
        this.captureHandler = null;
        this.deleted = [];
        this.sizes = new Map();
        this.lastSize = null;
        this.paths = new Set();
        this.files = new Map();
        this.dirs = new Map();
        this.config = {};
    }
    getVersion() { if (this.version instanceof Error) throw this.version; return this.version; }
    checkVersion() { return true; }
    size(path, options = {}) {
        this.lastSize = {path, ...options};
        return this.sizes.get(path) ?? {count: 0, bytes: 0};
    }
    exists(path) { return this.paths.has(path); }
    mkdir(path) { this.paths.add(path); }
    writeText(path, text) { this.files.set(path, text); this.paths.add(path); }
    readText(path) {
        if (!this.files.has(path))
            throw new Error(`Cannot read ${path}`);
        return this.files.get(path);
    }
    listDirs(path) { return this.dirs.get(path) ?? []; }
    runCapture(args) {
        this.captures.push(args);
        if (this.captureHandler) return this.captureHandler(args);
        return {exitCode: 0, stdout: '', stderr: ''};
    }
    configDump() { return this.config; }
    configCreate(name, type, options) {
        this.created = {name, type, options};
        this.paths.add(`${name}:`);
        if (this.captureHandler)
            return this.captureHandler(['config', 'create']);
        return {exitCode: 0, stdout: '', stderr: ''};
    }
    configDelete(name) { this.deleted.push(name); return {exitCode: 0, stderr: ''}; }
}

function makeService(overrides = {}) {
    const config = overrides.config || new FakeConfig();
    const state = overrides.state || new FakeState();
    const manager = overrides.manager || new FakeManager();
    const transfer = overrides.transfer || new FakeTransfer();
    let snapshots = 0;
    const service = new DaemonService({
        config,
        state,
        manager,
        restore: overrides.restore || {restore: () => ({ok: true, source: '/src'})},
        auth: overrides.auth || {
            begin: () => 'auth_1',
            get: () => '{"state":"waiting"}',
            cancel: () => {},
        },
        transfer,
        volumes: overrides.volumes || {list: () => [{uuid: 'u'}]},
        logger: overrides.logger || {warn() {}, error() {}},
        logs: overrides.logs === null ? null : (overrides.logs || {
            info: () => ({totalBytes: 10, files: 1}),
            prune: () => ({deleted: 1, bytesFreed: 10}),
            clear: scope => ({scope, deleted: 2}),
            sanitize: () => ({files: 1, changed: 1}),
        }),
        processMetrics: overrides.processMetrics || null,
        systemMetrics: overrides.systemMetrics || null,
        startedAt: '2026-01-01T00:00:00.000Z',
        idFactory: prefix => `${prefix}fixed`,
        getPid: () => 42,
        readTextTail: () => 'log text',
        findRclone: () => '/fallback/rclone',
        secureFile: overrides.secureFile || (() => {}),
        environment: {
            version: '1.0.0-dev',
            gjs: '1.88',
            configDir: '/config',
            stateDir: '/state',
        },
        onSnapshot: () => {
            snapshots++;
        },
    });
    return {service, config, state, manager, transfer, snapshots: () => snapshots};
}

function backupJob() {
    return {
        id: 'job_1',
        name: 'Backup',
        type: 'backup',
        source: {kind: 'local', path: '/src'},
        destination: {kind: 'local', path: '/dst'},
    };
}

export default suite('application/daemon-service', [
    test('snapshotJson includes daemon, jobs, remotes and volumes', () => {
        const ctx = makeService();
        ctx.config.jobs = [backupJob()];
        const snapshot = JSON.parse(ctx.service.snapshotJson());
        assertEqual(snapshot.version, '1.0.0-dev');
        assertEqual(snapshot.daemon.pid, 42);
        assertEqual(snapshot.daemon.process, null);
        assertEqual(snapshot.system, null);
        assertEqual(snapshot.jobs[0].state.status, 'idle');
        assertEqual(snapshot.remotes.length, 1);
        assertEqual(snapshot.volumes.length, 1);
    }),
    test('snapshotJson includes process and machine metrics when available', () => {
        const ctx = makeService({
            processMetrics: () => ({rssBytes: 1024}),
            systemMetrics: () => ({cpuPercent: 12, memory: {usedBytes: 1}}),
        });
        const snapshot = JSON.parse(ctx.service.snapshotJson());
        assertEqual(snapshot.daemon.process.rssBytes, 1024);
        assertEqual(snapshot.system.cpuPercent, 12);
        assertEqual(new DaemonService({}).logs, null);
    }),
    test('snapshotJson reports a missing rclone', () => {
        const ctx = makeService();
        ctx.transfer.version = new Error('missing');
        const snapshot = JSON.parse(ctx.service.snapshotJson());
        assertEqual(snapshot.daemon.rclone.path, '/usr/bin/rclone');
        assert(/missing/.test(snapshot.daemon.rclone.error));
    }),
    test('runJob validates supervisor state and starts a run', async () => {
        const ctx = makeService();
        await assertThrows(() => ctx.service.runJob('missing', false, false), /Job not found/);
        ctx.manager.addSupervisor('job_1');
        ctx.manager.supervisors.get('job_1').running = true;
        await assertThrows(() => ctx.service.runJob('job_1', false, false), /already running/);
        ctx.manager.supervisors.get('job_1').running = false;
        assertEqual(ctx.service.runJob('job_1', true, true), 'run_fixed');
        assertEqual(ctx.manager.calls[0][0], 'runJob');
    }),
    test('playJob validates supervisor state and starts a run', async () => {
        const ctx = makeService();
        await assertThrows(() => ctx.service.playJob('missing'), /Job not found/);
        ctx.manager.addSupervisor('job_1');
        ctx.manager.supervisors.get('job_1').running = true;
        await assertThrows(() => ctx.service.playJob('job_1'), /already running/);
        ctx.manager.supervisors.get('job_1').running = false;
        assertEqual(ctx.service.playJob('job_1'), 'run_fixed');
        assertEqual(ctx.manager.calls[0][0], 'playJob');
    }),
    test('deleteJob can remove the job folder in the destination', () => {
        const ctx = makeService();
        ctx.config.jobs = [backupJob()];
        ctx.manager.addSupervisor('job_1');
        ctx.transfer.paths.add('/dst/SaveMe/job_1');
        ctx.service.deleteJob('job_1', true);
        assert(ctx.transfer.captures.some(args =>
            args[0] === 'purge' && args[1] === '/dst/SaveMe/job_1'));
        assertEqual(ctx.config.getJob('job_1'), null);
    }),
    test('deleteJob refuses destination data for direct or running jobs', () => {
        const ctx = makeService();
        ctx.config.jobs = [{
            ...backupJob(),
            destinationLayout: 'direct',
        }];
        assertThrows(() => ctx.service.deleteJob('job_1', true), /legacy direct/);
        assert(ctx.config.getJob('job_1'));

        const running = makeService();
        running.config.jobs = [backupJob()];
        running.manager.addSupervisor('job_1');
        running.manager.supervisors.get('job_1').running = true;
        assertThrows(() => running.service.deleteJob('job_1', true), /Stop the job/);
    }),
    test('job mutations delegate and snapshot', () => {
        const ctx = makeService();
        ctx.config.jobs = [backupJob()];
        ctx.service.cancelJob('job_1');
        ctx.service.pauseJob('job_1', true);
        ctx.service.setJobEnabled('job_1', false);
        ctx.service.pauseAll(true);
        ctx.service.deleteJob('job_1');
        assertEqual(ctx.manager.calls[0][0], 'cancelJob');
        assertEqual(ctx.manager.calls[1][0], 'pauseJob');
        assertEqual(ctx.manager.calls[2][0], 'updateJob');
        assertEqual(ctx.manager.calls[3][0], 'pauseAll');
        assertEqual(ctx.manager.calls[4][0], 'removeJob');
        assert(ctx.snapshots() >= 5);
    }),
    test('setJobOptions updates the guard without restarting the job', () => {
        const ctx = makeService();
        ctx.config.jobs = [backupJob()];
        const saved = JSON.parse(ctx.service.setJobOptions('job_1',
            JSON.stringify({deleteGuardEnabled: false, maxDeletePercent: 25})));
        assertEqual(saved.options.deleteGuardEnabled, false);
        assertEqual(saved.options.maxDeletePercent, 25);
        const call = ctx.manager.calls.find(item => item[0] === 'updateJobOptions');
        assert(call);
        assertEqual(call[1], 'job_1');
        assertEqual(call[2].deleteGuardEnabled, false);
        assertEqual(ctx.manager.calls.some(item => item[0] === 'updateJob'), false);
        assertThrows(() => ctx.service.setJobOptions('missing', '{}'), /Job not found/);
    }),
    test('saveJob adds or updates and delegates', () => {
        const ctx = makeService();
        const saved = ctx.service.saveJob(JSON.stringify({
            id: 'new', name: 'New', type: 'sync', state: {status: 'running'},
        }));
        assertEqual(JSON.parse(saved).id, 'new');
        ctx.config.jobs = [{id: 'old', name: 'Old', type: 'sync'}];
        ctx.service.saveJob(JSON.stringify({id: 'old', name: 'Updated'}));
        assertEqual(ctx.config.getJob('old').name, 'Updated');
        assertEqual(ctx.manager.calls[0][0], 'addJob');
        assertEqual(ctx.manager.calls[1][0], 'addJob');
    }),
    test('new backup creates SaveMe, rejects an existing container and writes manifest', () => {
        const ctx = makeService();
        const payload = {...backupJob(), sources: [backupJob().source]};
        delete payload.state;
        const saved = JSON.parse(ctx.service.saveJob(JSON.stringify(payload)));
        assertEqual(saved.type, 'backup');
        assert(ctx.transfer.paths.has('/dst/SaveMe'));
        assert(ctx.transfer.paths.has('/dst/SaveMe/job_1/current'));
        assert(ctx.transfer.files.has('/dst/SaveMe/job_1/manifest.json'));

        const updated = JSON.parse(ctx.service.saveJob(JSON.stringify({
            ...saved,
            name: 'Renamed',
        })));
        assertEqual(updated.name, 'Renamed');
        assert(ctx.transfer.files.has('/dst/SaveMe/job_1/manifest.json'));

        const other = makeService();
        other.transfer.paths.add('/dst/SaveMe');
        const shared = JSON.parse(other.service.saveJob(JSON.stringify({
            id: 'job_2', name: 'Other', type: 'backup',
            source: {kind: 'local', path: '/src'},
            destination: {kind: 'local', path: '/dst'},
        })));
        assertEqual(shared.id, 'job_2');
        assert(other.transfer.paths.has('/dst/SaveMe/job_2/current'));
        assert(other.transfer.files.has('/dst/SaveMe/job_2/manifest.json'));
    }),
    test('manifest write failures remove a new backup job', () => {
        const ctx = makeService();
        ctx.transfer.writeText = () => {
            throw new Error('remote offline');
        };
        assertThrows(() => ctx.service.saveJob(JSON.stringify({
            ...backupJob(), sources: [backupJob().source],
        })), /remote offline/);
        assertEqual(ctx.config.getJob('job_1'), null);
        assert(ctx.transfer.captures.some(args =>
            args[0] === 'purge' && args[1] === '/dst/SaveMe/job_1'));
    }),
    test('draft backups skip the container until finalized', () => {
        const ctx = makeService();
        const draft = JSON.parse(ctx.service.saveJob(JSON.stringify({
            ...backupJob(),
            name: 'Draft',
            draft: true,
            draftStep: 2,
            enabled: false,
            sources: [backupJob().source],
        })));
        assertEqual(draft.draft, true);
        assertEqual(ctx.transfer.paths.has('/dst/SaveMe'), false);
        assertEqual(ctx.transfer.files.has('/dst/SaveMe/job_1/manifest.json'), false);

        const saved = JSON.parse(ctx.service.saveJob(JSON.stringify({
            ...draft,
            name: 'Backup',
            draft: false,
            draftStep: 0,
            enabled: true,
        })));
        assertEqual(saved.draft, false);
        assert(ctx.transfer.paths.has('/dst/SaveMe'));
        assert(ctx.transfer.paths.has('/dst/SaveMe/job_1/current'));
        assert(ctx.transfer.files.has('/dst/SaveMe/job_1/manifest.json'));
    }),
    test('a retried draft finalize adopts its own container', () => {
        const ctx = makeService();
        const draft = JSON.parse(ctx.service.saveJob(JSON.stringify({
            ...backupJob(),
            draft: true,
            draftStep: 4,
            enabled: false,
            sources: [backupJob().source],
        })));
        // A previous attempt created the container before the client timed out.
        ctx.transfer.paths.add('/dst/SaveMe');
        ctx.transfer.paths.add('/dst/SaveMe/job_1');
        const saved = JSON.parse(ctx.service.saveJob(JSON.stringify({
            ...draft,
            draft: false,
            draftStep: 0,
            enabled: true,
        })));
        assertEqual(saved.draft, false);
        assert(ctx.transfer.paths.has('/dst/SaveMe/job_1/current'));
        assert(ctx.transfer.paths.has('/dst/SaveMe/job_1/versions'));
        assert(ctx.transfer.files.has('/dst/SaveMe/job_1/manifest.json'));
    }),
    test('a failed draft finalize keeps the job as a draft', () => {
        const ctx = makeService();
        const draft = JSON.parse(ctx.service.saveJob(JSON.stringify({
            ...backupJob(),
            draft: true,
            draftStep: 4,
            enabled: false,
            sources: [backupJob().source],
        })));
        ctx.transfer.writeText = () => {
            throw new Error('offline');
        };
        assertThrows(() => ctx.service.saveJob(JSON.stringify({
            ...draft,
            draft: false,
            enabled: true,
        })), /offline/);
        assertEqual(ctx.config.getJob('job_1').draft, true);
        assertEqual(ctx.config.getJob('job_1').enabled, false);
    }),
    test('import and inspect backup jobs', () => {
        const ctx = makeService();
        const job = {...backupJob(), sources: [backupJob().source]};
        const manifest = JSON.stringify({
            version: 1,
            job,
        });
        ctx.transfer.dirs.set('/dst/SaveMe', ['job_1', 'broken']);
        ctx.transfer.writeText('/dst/SaveMe/job_1/manifest.json', manifest);
        ctx.transfer.paths.add('/src');
        const inspected = JSON.parse(ctx.service.inspectBackup('/dst/SaveMe'));
        assertEqual(inspected.jobs.length, 2);
        assertEqual(inspected.destination.path, '/dst');
        assertEqual(inspected.jobs[0].job.id, 'job_1');
        assertEqual(inspected.jobs[0].sources[0].exists, true);
        assertEqual(inspected.jobs[1].legacy, true);
        assertEqual(inspected.jobs[1].reason, 'missing-manifest');
        assertThrows(() => ctx.service.inspectBackup(''), /Backup folder is required/);
        const imported = JSON.parse(ctx.service.importJob(JSON.stringify(job)));
        assertEqual(imported.id, 'job_1');
        assertEqual(imported.enabled, false);
        assertEqual(ctx.manager.calls.at(-1)[0], 'addJob');
        const importedAgain = JSON.parse(ctx.service.importJob(JSON.stringify(job)));
        assertEqual(importedAgain.id, 'job_1');
        assertThrows(() => ctx.service.importJob(JSON.stringify({id: 'x', type: 'other'})),
            /Only sync and backup/);
    }),
    test('runJob and playJob log asynchronous failures', async () => {
        const ctx = makeService();
        ctx.config.jobs = [backupJob()];
        ctx.manager.addSupervisor('job_1');
        let warnings = 0;
        let errors = 0;
        ctx.service.logger.warn = () => {
            warnings++;
        };
        ctx.service.logger.error = () => {
            errors++;
        };
        ctx.manager.runJob = async () => null;
        ctx.service.runJob('job_1');
        await Promise.resolve();
        ctx.manager.playJob = async () => {
            throw new Error('boom');
        };
        ctx.service.playJob('job_1');
        await Promise.resolve();
        await Promise.resolve();
        assertEqual(warnings, 1);
        assertEqual(errors, 1);
    }),
    test('saveJob skips manifests for direct sync destinations', () => {
        const ctx = makeService();
        ctx.service.saveJob(JSON.stringify({
            id: 'direct_1',
            name: 'Direct',
            type: 'sync',
            source: {kind: 'local', path: '/src'},
            destination: {kind: 'local', path: '/dst'},
            destinationLayout: 'direct',
        }));
        assert(!ctx.transfer.paths.has('/dst/SaveMe/direct_1'));
    }),
    test('saveJob updates an existing sync manifest', () => {
        const ctx = makeService();
        const job = {
            id: 'sync_1',
            name: 'Sync',
            type: 'sync',
            source: {kind: 'local', path: '/src'},
            destination: {kind: 'local', path: '/dst'},
            destinationLayout: 'saveMe',
        };
        ctx.service.saveJob(JSON.stringify(job));
        job.name = 'Updated';
        ctx.service.saveJob(JSON.stringify(job));
        assert(ctx.transfer.files.get('/dst/SaveMe/sync_1/manifest.json')
            .includes('Updated'));
    }),
    test('saveJob cleans partial containers when manifest writes fail', () => {
        const ctx = makeService();
        ctx.transfer.writeText = () => {
            throw new Error('write failed');
        };
        ctx.transfer.runCapture = () => {
            throw new Error('purge failed');
        };
        assertThrows(() => ctx.service.saveJob(JSON.stringify({
            id: 'job_bad',
            name: 'Bad',
            type: 'backup',
            source: {kind: 'local', path: '/src'},
            destination: {kind: 'local', path: '/dst'},
        })), /write failed/);
        assertEqual(ctx.config.getJob('job_bad'), null);
    }),
    test('inspectBackup survives unreadable legacy folders', () => {
        const ctx = makeService();
        ctx.transfer.listDirs = path => {
            if (path === '/dst/SaveMe')
                return ['job_missing'];
            throw new Error('listing failed');
        };
        const inspected = JSON.parse(ctx.service.inspectBackup('/dst/SaveMe'));
        assertEqual(inspected.jobs[0].reason, 'missing-manifest');
        assertEqual(inspected.jobs[0].type, 'sync');
    }),
    test('inspectBackup falls back for sources without a resolved path', () => {
        const ctx = makeService();
        const job = {
            ...backupJob(),
            sources: [
                {kind: 'local'},
                {kind: 'remote', remote: '', path: '/docs'},
            ],
        };
        ctx.transfer.dirs.set('/dst/SaveMe', ['job_1']);
        ctx.transfer.writeText('/dst/SaveMe/job_1/manifest.json',
            JSON.stringify({version: 1, job}));
        const inspected = JSON.parse(ctx.service.inspectBackup('/dst/SaveMe'));
        assertEqual(inspected.jobs[0].sources[0].path, '');
        assertEqual(inspected.jobs[0].sources[0].exists, null);
        assertEqual(inspected.jobs[0].sources[1].path, ':/docs');
        assertEqual(inspected.jobs[0].sources[1].remote, true);
    }),
    test('deleteJob handles missing, running and purge failures', () => {
        const ctx = makeService();
        assertThrows(() => ctx.service.deleteJob('missing', true), /Job not found/);
        ctx.config.jobs = [backupJob()];
        ctx.manager.addSupervisor('job_1');
        ctx.manager.supervisors.get('job_1').running = true;
        assertThrows(() => ctx.service.deleteJob('job_1', true),
            /Stop the job before deleting/);
        ctx.manager.supervisors.get('job_1').running = false;
        ctx.transfer.captureHandler = () => ({
            exitCode: 1,
            stdout: '',
            stderr: '{"level":"error","msg":"purge failed"}',
        });
        assertThrows(() => ctx.service.deleteJob('job_1', true), /purge failed/);
    }),
    test('new sync jobs create a SaveMe container and manifest', () => {
        const ctx = makeService();
        const saved = JSON.parse(ctx.service.saveJob(JSON.stringify({
            id: 'sync_1',
            name: 'Sync',
            type: 'sync',
            source: {kind: 'local', path: '/src'},
            destination: {kind: 'local', path: '/dst'},
            destinationLayout: 'saveMe',
            trigger: {mode: 'realtime'},
        })));
        assertEqual(saved.id, 'sync_1');
        assert(ctx.transfer.paths.has('/dst/SaveMe/sync_1'));
        assert(ctx.transfer.paths.has('/dst/SaveMe/sync_1/current'));
        assert(!ctx.transfer.paths.has('/dst/SaveMe/sync_1/versions'));
        assert(ctx.transfer.files.has('/dst/SaveMe/sync_1/manifest.json'));
    }),
    test('inspectBackup reports source status and tolerates bad manifests', () => {
        const ctx = makeService();
        const job = {
            ...backupJob(),
            id: 'old_id',
            sources: [
                {kind: 'local', path: '/src'},
                {kind: 'local', path: '/missing'},
                {kind: 'remote', remote: 'drive', path: '/docs'},
            ],
        };
        ctx.transfer.dirs.set('/dst/SaveMe',
            ['job_1', 'job_unreadable', 'job_legacy_backup']);
        ctx.transfer.writeText('/dst/SaveMe/job_1/manifest.json',
            JSON.stringify({version: 1, job}));
        ctx.transfer.writeText('/dst/SaveMe/job_unreadable/manifest.json', 'not json');
        ctx.transfer.dirs.set('/dst/SaveMe/job_legacy_backup', ['current', 'versions']);
        ctx.transfer.paths.add('/src');
        const inspected = JSON.parse(ctx.service.inspectBackup('/dst/SaveMe'));
        const recovered = inspected.jobs.find(entry => entry.id === 'job_1');
        assertEqual(recovered.job.id, 'job_1');
        assertEqual(recovered.idMismatch, true);
        assertEqual(recovered.sources[0].exists, true);
        assertEqual(recovered.sources[1].exists, false);
        assertEqual(recovered.sources[2].exists, null);
        assertEqual(recovered.sources[2].remote, true);
        const unreadable = inspected.jobs.find(entry => entry.id === 'job_unreadable');
        assertEqual(unreadable.reason, 'unreadable');
        const legacy = inspected.jobs.find(entry => entry.id === 'job_legacy_backup');
        assertEqual(legacy.reason, 'missing-manifest');
        assertEqual(legacy.type, 'backup');
    }),
    test('inspectBackup reports unknown source checks without failing', () => {
        const ctx = makeService();
        const job = {...backupJob(), sources: [{kind: 'local', path: '/src'}]};
        ctx.transfer.dirs.set('/dst/SaveMe', ['job_1']);
        ctx.transfer.writeText('/dst/SaveMe/job_1/manifest.json',
            JSON.stringify({version: 1, job}));
        ctx.transfer.exists = () => {
            throw new Error('network down');
        };
        const inspected = JSON.parse(ctx.service.inspectBackup('/dst/SaveMe'));
        assertEqual(inspected.jobs[0].sources[0].exists, null);
    }),
    test('jobSize reports the destination folder size', () => {
        const ctx = makeService();
        ctx.config.jobs = [backupJob()];
        ctx.transfer.sizes.set('/dst/SaveMe/job_1', {bytes: 2048, count: 3});
        const size = JSON.parse(ctx.service.jobSize('job_1'));
        assertEqual(size.bytes, 2048);
        assertEqual(size.count, 3);
        ctx.config.jobs = [{
            ...backupJob(),
            type: 'sync',
            destinationLayout: 'direct',
        }];
        ctx.transfer.sizes.set('/dst', {});
        const direct = JSON.parse(ctx.service.jobSize('job_1'));
        assertEqual(direct.bytes, 0);
        assertEqual(direct.count, 0);
        assertThrows(() => ctx.service.jobSize('missing'), /Job not found/);
    }),
    test('remoteWebUrl resolves OneDrive item IDs and provider paths', () => {
        const ctx = makeService();
        ctx.transfer.config = {
            onedrive: {type: 'onedrive', drive_id: 'drive1', drive_type: 'personal'},
            dropbox: {type: 'dropbox'},
            drive: {type: 'drive'},
        };
        ctx.transfer.captureHandler = args => {
            assertEqual(args[0], 'lsjson');
            return {
                exitCode: 0,
                stdout: JSON.stringify([{
                    Name: 'current',
                    ID: 'drive1#item1',
                    Metadata: {id: 'drive1#item1'},
                }]),
                stderr: '',
            };
        };
        assertEqual(ctx.service.remoteWebUrl('onedrive', 'Ubuntu/SaveMe/job/current'),
            'https://onedrive.live.com/?id=item1&cid=drive1');
        assertEqual(ctx.service.remoteWebUrl('dropbox', 'SaveMe/job/current'),
            'https://www.dropbox.com/home/SaveMe/job/current');
        assertEqual(ctx.service.remoteWebUrl('drive', 'SaveMe/job/current'),
            'https://drive.google.com/drive/search?q=SaveMe%2Fjob%2Fcurrent');
        assertThrows(() => ctx.service.remoteWebUrl('', 'x'), /Remote is required/);
        assertThrows(() => ctx.service.remoteWebUrl('missing', 'x'), /Remote not found/);
        assertEqual(ctx.service.remoteWebUrl('onedrive', ''), 'https://onedrive.live.com/');
        assertEqual(ctx.service.remoteWebUrl('dropbox', ''), 'https://www.dropbox.com/home/');
        assertEqual(ctx.service.remoteWebUrl('drive', ''),
            'https://drive.google.com/drive/search?q=SaveMe');

        ctx.transfer.config.onedrive.drive_type = 'business';
        assertEqual(ctx.service.remoteWebUrl('onedrive', 'Ubuntu/SaveMe/job/current'),
            'https://www.microsoft365.com/?id=item1&cid=drive1');
        ctx.transfer.config.onedrive.drive_type = 'personal';

        ctx.transfer.captureHandler = () => ({
            exitCode: 0,
            stdout: JSON.stringify([{
                Name: 'current',
                Metadata: {id: 'item2'},
            }]),
            stderr: '',
        });
        assertEqual(ctx.service.remoteWebUrl('onedrive', 'current'),
            'https://onedrive.live.com/?id=item2&cid=drive1');

        ctx.transfer.captureHandler = () => ({
            exitCode: 0,
            stdout: JSON.stringify([{Name: 'current', ID: 'drive1#item3'}]),
            stderr: '',
        });
        assertEqual(ctx.service.remoteWebUrl('onedrive', 'Ubuntu/SaveMe/job/current'),
            'https://onedrive.live.com/?id=item3&cid=drive1');
        ctx.transfer.config.onedrive.drive_id = '';
        ctx.transfer.captureHandler = () => ({
            exitCode: 0,
            stdout: JSON.stringify([{Name: 'current', Metadata: {id: 'item4'}}]),
            stderr: '',
        });
        assertEqual(ctx.service.remoteWebUrl('onedrive', 'Ubuntu/SaveMe/job/current'),
            'https://onedrive.live.com/?id=item4');
        ctx.transfer.config.onedrive.drive_type = 'business';
        assertEqual(ctx.service.remoteWebUrl('onedrive', 'Ubuntu/SaveMe/job/current'),
            'https://www.microsoft365.com/?id=item4');
        ctx.transfer.config.onedrive.drive_type = 'personal';
        ctx.transfer.config.onedrive.drive_id = 'drive1';
        ctx.transfer.captureHandler = () => ({
            exitCode: 0,
            stdout: JSON.stringify([{Name: 'other'}]),
            stderr: '',
        });
        assertEqual(ctx.service.remoteWebUrl('onedrive', 'Ubuntu/SaveMe/job/current'),
            'https://onedrive.live.com/');

        ctx.transfer.captureHandler = () => ({exitCode: 0, stdout: 'not json', stderr: ''});
        assertEqual(ctx.service.remoteWebUrl('onedrive', 'Ubuntu/SaveMe/job/current'),
            'https://onedrive.live.com/');

        ctx.transfer.captureHandler = () => ({exitCode: 1, stdout: '', stderr: 'boom'});
        assertEqual(ctx.service.remoteWebUrl('onedrive', 'Ubuntu/SaveMe/job/current'),
            'https://onedrive.live.com/');

        ctx.transfer.config.s3 = {type: 's3'};
        assertThrows(() => ctx.service.remoteWebUrl('s3', 'x'), /not supported/);
    }),
    test('createRemote configures a Nextcloud WebDAV remote', async () => {
        const ctx = makeService();
        const remote = JSON.parse(ctx.service.createRemote(JSON.stringify({
            name: 'Meu Nextcloud',
            type: 'nextcloud',
            options: {
                url: 'https://cloud.example.com/remote.php/dav/files/me',
                user: 'me',
                pass: 'secret',
            },
        })));
        assertEqual(remote.type, 'nextcloud');
        assertEqual(ctx.transfer.created.type, 'webdav');
        assertEqual(ctx.transfer.created.options.url,
            'https://cloud.example.com/remote.php/dav/files/me');
        assertEqual(ctx.config.getRemote('Meu Nextcloud').options.user, 'me');
        await assertThrows(() => ctx.service.createRemote(JSON.stringify({
            name: 'bad/name', type: 'nextcloud', options: {},
        })), /Invalid remote name|URL, user and password/);
        await assertThrows(() => ctx.service.createRemote(JSON.stringify({
            name: 'nc', type: 'ftp', options: {},
        })), /Unsupported remote type/);
        await assertThrows(() => ctx.service.createRemote(JSON.stringify({
            name: 'nc', type: 'nextcloud', options: {url: 'https://x'},
        })), /URL, user and password/);
        ctx.transfer.captureHandler = () => ({exitCode: 7, stdout: '', stderr: 'boom'});
        await assertThrows(() => ctx.service.createRemote(JSON.stringify({
            name: 'nc2', type: 'nextcloud',
            options: {url: 'https://x', user: 'u', pass: 'p'},
        })), /boom/);
        ctx.transfer.captureHandler = null;
        ctx.service.createRemote(JSON.stringify({
            name: 'Meu Nextcloud', type: 'nextcloud',
            options: {url: 'https://changed', user: 'me', pass: 'secret'},
        }));
        assertEqual(ctx.config.getRemote('Meu Nextcloud').options.url, 'https://changed');
    }),
    test('createRemote configures an S3-compatible remote', async () => {
        const ctx = makeService();
        const remote = JSON.parse(ctx.service.createRemote(JSON.stringify({
            name: 'S3 Backup',
            type: 's3',
            options: {
                endpoint: 'https://s3.eu-central-1.amazonaws.com',
                region: 'eu-central-1',
                accessKey: 'access',
                secretKey: 'secret',
            },
        })));
        assertEqual(remote.type, 's3');
        assertEqual(ctx.transfer.created.type, 's3');
        assertEqual(ctx.transfer.created.options.endpoint,
            'https://s3.eu-central-1.amazonaws.com');
        await assertThrows(() => ctx.service.createRemote(JSON.stringify({
            name: 'S3 Broken', type: 's3', options: {endpoint: 'x'},
        })), /S3 endpoint, access key and secret key/);
    }),
    test('importJob rejects legacy direct sync jobs', () => {
        const ctx = makeService();
        assertThrows(() => ctx.service.importJob(JSON.stringify({
            id: 'legacy', type: 'sync', destinationLayout: 'direct',
        })), /Legacy direct/);
    }),
    test('inspect and import sync manifests', () => {
        const ctx = makeService();
        const job = {
            id: 'job_sync',
            name: 'Sync',
            type: 'sync',
            sources: [{kind: 'local', path: '/src'}],
            destination: {kind: 'local', path: '/dst'},
            destinationLayout: 'saveMe',
            trigger: {mode: 'realtime'},
        };
        ctx.transfer.dirs.set('/dst/SaveMe', ['job_sync']);
        ctx.transfer.writeText('/dst/SaveMe/job_sync/manifest.json',
            JSON.stringify({version: 1, job}));
        ctx.transfer.paths.add('/src');
        const inspected = JSON.parse(ctx.service.inspectBackup('/dst/SaveMe'));
        assertEqual(inspected.jobs[0].job.type, 'sync');
        assertEqual(inspected.jobs[0].sources[0].exists, true);
        const imported = JSON.parse(ctx.service.importJob(JSON.stringify(job)));
        assertEqual(imported.type, 'sync');
        assertEqual(imported.enabled, false);
        assertEqual(imported.destinationLayout, 'saveMe');
        assertEqual(imported.trigger.mode, 'manual');
    }),
    test('runs and logs use the state/read adapter', () => {
        const ctx = makeService();
        ctx.state.runs.set('job_1:run_1', {id: 'run_1', logFile: '/log'});
        assert(/run_1/.test(ctx.service.getRun('job_1', 'run_1')));
        assertEqual(ctx.service.getRunLog('job_1', 'run_1'), 'log text');
        assertEqual(JSON.parse(ctx.service.listRuns('job_1', 5)).length, 1);
        assertThrows(() => ctx.service.getRunLog('job_1', 'missing'), /Run not found/);
    }),
    test('listVersions handles missing, non-backup and backup jobs', () => {
        const ctx = makeService();
        assertThrows(() => ctx.service.listVersions('missing'), /Job not found/);
        ctx.config.jobs = [{id: 'sync', type: 'sync'}];
        assertEqual(ctx.service.listVersions('sync'), '[]');
        ctx.config.jobs = [backupJob()];
        ctx.transfer.captureHandler = () => ({
            exitCode: 0,
            stdout: '20260101T000000-000-a/\n20260102T000000-000-b/\n',
            stderr: '',
        });
        const versions = JSON.parse(ctx.service.listVersions('job_1'));
        assertEqual(versions[0].name, '20260102T000000-000-b');
    }),
    test('listRemote handles directories, files and missing remotes', () => {
        const ctx = makeService();
        assertThrows(() => ctx.service.listRemote('missing', '', false), /Remote not found/);
        ctx.transfer.captureHandler = () => ({
            exitCode: 0,
            stdout: 'dir/\nfile.txt\n',
            stderr: '',
        });
        const dirs = JSON.parse(ctx.service.listRemote('drive', '', true));
        assertEqual(dirs[0].name, 'dir');
        ctx.transfer.captureHandler = () => ({
            exitCode: 0,
            stdout: '[{"Name":"a","IsDir":false,"Size":2},{"Path":"d","IsDir":true}]',
            stderr: '',
        });
        const entries = JSON.parse(ctx.service.listRemote('drive', 'x', false));
        assertEqual(entries[0].name, 'd');
        ctx.transfer.captureHandler = () => ({exitCode: 3, stdout: '', stderr: ''});
        assertEqual(ctx.service.listRemote('drive', '', false), '[]');
        ctx.transfer.captureHandler = () => ({exitCode: 0, stdout: '{bad', stderr: ''});
        assertThrows(() => ctx.service.listRemote('drive', '', false), /Invalid rclone lsjson/);
        ctx.transfer.sizes.set('drive:', {count: 10000, bytes: 100});
        assertThrows(() => ctx.service.listRemote('drive', '', false),
            /open a subfolder/);
        ctx.transfer.sizes.clear();
        ctx.transfer.size = () => {
            throw new Error('size unavailable');
        };
        assertEqual(JSON.parse(ctx.service.listRemote('drive', '', true)).length, 1);
    }),
    test('listBackup handles current, version and invalid inputs', () => {
        const ctx = makeService();
        assertThrows(() => ctx.service.listBackup('missing', '', '', false), /Job not found/);
        ctx.config.jobs = [{id: 'sync', type: 'sync'}];
        assertThrows(() => ctx.service.listBackup('sync', '', '', false), /not a backup/);
        ctx.config.jobs = [backupJob()];
        assertThrows(() => ctx.service.listBackup('job_1', 'nope', '', false), /Invalid version/);
        ctx.transfer.captureHandler = () => ({exitCode: 0, stdout: '[]', stderr: ''});
        assertEqual(ctx.service.listBackup('job_1', '', '', false), '[]');
        assertEqual(ctx.service.listBackup('job_1', '20260102T000000-000-a', 'x', false), '[]');
    }),
    test('restore and auth delegate', () => {
        const ctx = makeService();
        assertThrows(() => ctx.service.restore(JSON.stringify({jobId: 'missing'})), /Job not found/);
        ctx.config.jobs = [backupJob()];
        const restored = JSON.parse(ctx.service.restore(JSON.stringify({
            jobId: 'job_1', target: '/restore', path: '', version: '',
        })));
        assertEqual(restored.ok, true);
        assertEqual(ctx.service.beginRemoteAuth('drive', 'x'), 'auth_1');
        assert(/waiting/.test(ctx.service.getRemoteAuth('auth_1')));
        ctx.service.cancelRemoteAuth('auth_1');
    }),
    test('deleteRemote rejects jobs and deletes unused remotes', () => {
        const ctx = makeService();
        ctx.config.jobs = [{...backupJob(), name: 'Uses drive', destination: {
            kind: 'remote', remote: 'drive', path: '',
        }}];
        assertThrows(() => ctx.service.deleteRemote('drive'), /used by jobs/);
        ctx.config.jobs = [{...backupJob(), name: 'Draft uses drive', draft: true,
            destination: {kind: 'remote', remote: 'drive', path: ''},
        }];
        ctx.service.deleteRemote('drive');
        assertEqual(ctx.transfer.deleted[0], 'drive');
        assertEqual(ctx.config.remotes.length, 0);
        ctx.config.remotes = [{name: 'other'}];
        ctx.transfer.configDelete = () => ({exitCode: 7, stderr: 'delete failed'});
        assertThrows(() => ctx.service.deleteRemote('other'), /delete failed/);
    }),
    test('maps rclone output and tolerates optional services', async () => {
        const ctx = makeService();
        ctx.transfer.captureHandler = () => ({
            exitCode: 7, stdout: 'plain failure', stderr: '',
        });
        assertThrows(() => ctx.service.listRemote('drive', '', false), /plain failure/);

        ctx.transfer.captureHandler = () => ({
            exitCode: 7, stdout: '{"level":"info","msg":"allowed"}', stderr: '',
        });
        assertThrows(() => ctx.service.listRemote('drive', '', false), /allowed/);

        ctx.transfer.captureHandler = () => ({
            exitCode: 7, stdout: '',
            stderr: '{"level":"critical","msg":"drive_id missing"}',
        });
        assertThrows(() => ctx.service.listRemote('drive', '', false), /misconfigured/);
        assertThrows(() => ctx.service.listRemote('', '', false), /Remote not found/);

        const added = JSON.parse(ctx.service.saveJob(JSON.stringify({
            id: 'missing', name: 'Added', type: 'sync',
        })));
        assertEqual(added.id, 'missing');
        const generated = JSON.parse(ctx.service.saveJob(JSON.stringify({
            name: 'Generated', type: 'sync',
        })));
        assertEqual(generated.name, 'Generated');

        ctx.config.jobs = [backupJob()];
        ctx.transfer.writeText = () => {
            throw new Error('offline');
        };
        ctx.service.saveJob(JSON.stringify({...backupJob(), name: 'Changed'}));

        const settings = makeService({logs: null});
        assertEqual(JSON.parse(settings.service.doctorJson()).logs, null);
        await assertThrows(() => settings.service.updateSettingsJson('null'),
            /Invalid settings/);
        await assertThrows(() => settings.service.updateSettingsJson('3'),
            /Invalid settings/);
    }),
    test('doctorJson reports rclone success and failure', () => {
        const ctx = makeService();
        const ok = JSON.parse(ctx.service.doctorJson());
        assertEqual(ok.rclone.ok, true);
        assertEqual(ok.jobs, 0);
        const failed = makeService();
        failed.transfer.version = new Error('missing');
        const bad = JSON.parse(failed.service.doctorJson());
        assertEqual(bad.rclone.ok, false);
    }),
    test('settings can disable start at login without starting jobs', () => {
        const ctx = makeService();
        ctx.config.settings.startAtLogin = true;
        const settings = JSON.parse(ctx.service.updateSettingsJson(
            JSON.stringify({startAtLogin: false})));
        assertEqual(settings.startAtLogin, false);
    }),
    test('log management and settings delegate', async () => {
        const ctx = makeService();
        assertEqual(JSON.parse(ctx.service.logsInfoJson()).totalBytes, 10);
        assertEqual(JSON.parse(ctx.service.pruneLogsJson()).deleted, 1);
        assertEqual(JSON.parse(ctx.service.clearLogsJson('daemon')).scope, 'daemon');
        assertEqual(JSON.parse(ctx.service.sanitizeLogsJson()).changed, 1);
        const settings = JSON.parse(ctx.service.updateSettingsJson(
            JSON.stringify({logRetentionDays: 7})));
        assertEqual(settings.logRetentionDays, 7);
        const concurrent = JSON.parse(ctx.service.updateSettingsJson(
            JSON.stringify({maxConcurrentJobs: 3})));
        assertEqual(concurrent.maxConcurrentJobs, 3);
        assert(JSON.stringify(ctx.manager.calls.at(-1)) ===
            JSON.stringify(['setConcurrency', 3]));
        ctx.config.settings.startAtLogin = false;
        const login = JSON.parse(ctx.service.updateSettingsJson(
            JSON.stringify({startAtLogin: true})));
        assertEqual(login.startAtLogin, true);
        assertEqual(ctx.manager.calls.at(-1)[0], 'startAll');
        await assertThrows(() => ctx.service.updateSettingsJson('[]'), /Invalid settings/);
        const withoutLogs = makeService({logs: null});
        await assertThrows(() => withoutLogs.service.logsInfoJson(),
            /Log management is not available/);
        await assertThrows(() => withoutLogs.service.pruneLogsJson(),
            /Log management is not available/);
        await assertThrows(() => withoutLogs.service.clearLogsJson('daemon'),
            /Log management is not available/);
        await assertThrows(() => withoutLogs.service.sanitizeLogsJson(),
            /Log management is not available/);
    }),
    test('listVersions handles empty, missing and errored roots', () => {
        const ctx = makeService();
        ctx.config.jobs = [backupJob()];
        ctx.transfer.captureHandler = () => ({exitCode: 3, stdout: '', stderr: ''});
        assertEqual(ctx.service.listVersions('job_1'), '[]');
        ctx.transfer.captureHandler = () => ({exitCode: 7, stdout: '', stderr: 'boom'});
        assertThrows(() => ctx.service.listVersions('job_1'), /boom/);
        ctx.transfer.captureHandler = () => ({
            exitCode: 0,
            stdout: 'not-a-date\n20260101T000000-000-a\n',
            stderr: '',
        });
        const versions = JSON.parse(ctx.service.listVersions('job_1'));
        assertEqual(versions[0].date, null);
        assertEqual(versions[1].date !== null, true);
    }),
    test('listRemote handles empty output and richer entries', () => {
        const ctx = makeService();
        ctx.transfer.captureHandler = () => ({exitCode: 0, stdout: '', stderr: ''});
        assertEqual(ctx.service.listRemote('drive', '', false), '[]');
        ctx.transfer.captureHandler = () => ({
            exitCode: 0,
            stdout: JSON.stringify([
                {Path: 'dir-b', IsDir: true, ModTime: 'now'},
                {Name: 'dir-a', IsDir: true},
                {Name: 'file-b', IsDir: false},
                {Path: 'file-a', IsDir: false},
                {Name: '', IsDir: false},
            ]),
            stderr: '',
        });
        const entries = JSON.parse(ctx.service.listRemote('drive', '', false));
        assertEqual(entries.length, 4);
        assertEqual(entries[0].name, 'dir-a');
        assertEqual(entries[1].name, 'dir-b');
        assertEqual(entries[2].name, 'file-a');
        ctx.transfer.captureHandler = () => ({exitCode: 7, stdout: '', stderr: 'boom'});
        assertThrows(() => ctx.service.listRemote('drive', '', false), /boom/);
    }),
    test('listBackup handles remote destinations and directory listings', () => {
        const ctx = makeService();
        ctx.config.jobs = [{
            ...backupJob(),
            destination: {kind: 'remote', remote: 'drive', path: 'backups'},
        }];
        ctx.transfer.captureHandler = () => ({
            exitCode: 0,
            stdout: 'dir/\n',
            stderr: '',
        });
        const entries = JSON.parse(ctx.service.listBackup('job_1', '', '', true));
        assertEqual(entries[0].name, 'dir');
        ctx.transfer.captureHandler = () => ({exitCode: 3, stdout: '', stderr: ''});
        assertEqual(ctx.service.listBackup('job_1', '', '', false), '[]');
    }),
    test('getRun and listRuns handle missing/default values', () => {
        const ctx = makeService();
        assertEqual(ctx.service.getRun('job', 'missing'), '{}');
        ctx.state.runs.set('job:run', {id: 'run'});
        assertEqual(JSON.parse(ctx.service.listRuns('job', 0)).length, 1);
        assertEqual(JSON.parse(ctx.service.listRuns('job')).length, 1);
    }),
    test('auth and deleteRemote cover optional arguments and fallback errors', () => {
        const ctx = makeService();
        assertEqual(ctx.service.beginRemoteAuth('drive', 'x', ''), 'auth_1');
        ctx.config.remotes = [{name: 'other'}];
        ctx.transfer.configDelete = () => ({exitCode: 7, stderr: ''});
        assertThrows(() => ctx.service.deleteRemote('other'), /Fatal error/);
    }),
]);
