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
    addJob(job) { this.calls.push(['addJob', job]); }
    removeJob(id) { this.calls.push(['removeJob', id]); }
    pauseAll(paused) { this.calls.push(['pauseAll', paused]); }
    setConcurrency(limit) { this.calls.push(['setConcurrency', limit]); }
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
        ctx.transfer.files.set('/dst/SaveMe/job_1/manifest.json', manifest);
        const inspected = JSON.parse(ctx.service.inspectBackup('/dst/SaveMe'));
        assertEqual(inspected.jobs.length, 2);
        assertEqual(inspected.jobs[0].job.id, 'job_1');
        assert(/Cannot read/.test(inspected.jobs[1].error));
        assertThrows(() => ctx.service.inspectBackup(''), /Backup folder is required/);
        const imported = JSON.parse(ctx.service.importJob(JSON.stringify(job)));
        assertEqual(imported.id, 'job_1');
        assertEqual(ctx.manager.calls.at(-1)[0], 'addJob');
        const importedAgain = JSON.parse(ctx.service.importJob(JSON.stringify(job)));
        assertEqual(importedAgain.id, 'job_1');
        assertThrows(() => ctx.service.importJob(JSON.stringify({id: 'x', type: 'sync'})),
            /Only backup/);
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
