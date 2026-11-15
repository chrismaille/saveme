import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import system from 'system';
import {DaemonClient} from '../../app/daemon-client.js';
import {defaultJob, JOB_TYPES} from '../../src/jobs.js';
import {
    atomicWriteText,
    readText,
    removeRecursive,
    sleep,
} from '../../src/util.js';

const HERE = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const ROOT = GLib.path_get_dirname(GLib.path_get_dirname(HERE));
const BASE = GLib.getenv('SAVEME_E2E_ROOT') ||
    GLib.dir_make_tmp('saveme-e2e-XXXXXX');
const LOG = GLib.build_filenamev([BASE, 'daemon.log']);
const COVERAGE_DIR = GLib.getenv('SAVEME_E2E_COVERAGE_DIR');
let daemonRuns = 0;

GLib.setenv('SAVEME_E2E_DAEMON',
    GLib.build_filenamev([ROOT, 'bin', 'saveme-daemon.js']), true);
GLib.setenv('SAVEME_E2E_LOG', LOG, true);

let daemon = null;
let client = null;
let passed = 0;
let failed = 0;

function ok(name) {
    passed++;
    print(`ok - ${name}`);
}

function fail(name, error) {
    failed++;
    print(`not ok - ${name}`);
    print(`  ${error.message || error}`);
    if (error.stack)
        print(error.stack.split('\n').slice(1, 6).join('\n'));
}

function path(...parts) {
    return GLib.build_filenamev([BASE, ...parts]);
}

function write(file, content) {
    atomicWriteText(file, content, 0o600);
}

function deleteFile(file) {
    const f = Gio.File.new_for_path(file);
    if (f.query_exists(null))
        f.delete(null);
}

function startDaemon() {
    let flags = '';
    if (COVERAGE_DIR) {
        const out = GLib.build_filenamev([
            COVERAGE_DIR, `daemon-${++daemonRuns}`,
        ]);
        GLib.mkdir_with_parents(out, 0o700);
        flags = `--coverage-prefix=file://${ROOT} ` +
            `--coverage-output=${out}`;
    }
    GLib.setenv('SAVEME_E2E_GJS_FLAGS', flags, true);
    daemon = Gio.Subprocess.new([
        'sh', '-c',
        'exec gjs $SAVEME_E2E_GJS_FLAGS -m "$SAVEME_E2E_DAEMON" ' +
        '>> "$SAVEME_E2E_LOG" 2>&1',
    ], Gio.SubprocessFlags.NONE);
}

async function killDaemon(proc) {
    if (!proc)
        return;
    try {
        proc.force_exit();
    } catch (_) {
        // Already gone.
    }
    await new Promise(resolve => {
        proc.wait_async(null, (p, result) => {
            try {
                p.wait_finish(result);
            } catch (_) {
                // Ignore.
            }
            resolve();
        });
    });
}

async function waitFor(predicate, {timeout = 20000, interval = 250} = {}) {
    const deadline = Date.now() + timeout;
    let lastError = null;
    while (Date.now() < deadline) {
        try {
            if (await predicate())
                return;
        } catch (e) {
            lastError = e;
        }
        await sleep(interval);
    }
    throw lastError || new Error('Timed out waiting for condition');
}

function daemonNameOwned() {
    return new Promise((resolve, reject) => {
        const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
        bus.call(
            'org.freedesktop.DBus',
            '/org/freedesktop/DBus',
            'org.freedesktop.DBus',
            'NameHasOwner',
            new GLib.Variant('(s)', ['io.github.chrismaille.SaveMe.Daemon']),
            null,
            Gio.DBusCallFlags.NONE,
            3000,
            null,
            (connection, result) => {
                try {
                    const [owned] = connection.call_finish(result).deepUnpack();
                    resolve(Boolean(owned));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

async function waitForDaemon() {
    // Do not call GetSnapshot before the name exists: D-Bus activation could
    // start the installed daemon instead of our test process.
    await waitFor(() => daemonNameOwned(), {timeout: 20000, interval: 100});
    let lastError = null;
    for (let i = 0; i < 80; i++) {
        try {
            client = new DaemonClient();
            return await client.getSnapshot();
        } catch (e) {
            lastError = e;
            client?.close();
            client = null;
            await sleep(150);
        }
    }
    throw lastError || new Error('Daemon object not exported');
}

function stopDaemon(proc) {
    return new Promise(resolve => {
        if (!proc)
            return resolve();
        try {
            proc.send_signal(15);
        } catch (_) {
            // Already gone.
        }
        proc.wait_async(null, (p, result) => {
            try {
                p.wait_finish(result);
            } catch (_) {
                // Ignore.
            }
            resolve();
        });
    });
}

async function runJob(jobId) {
    const runId = await client.runJob(jobId, false, false);
    let run = null;
    await waitFor(async () => {
        run = await client.getRun(jobId, runId);
        return run && run.result;
    }, {timeout: 30000});
    return run;
}

async function fileEquals(file, content) {
    try {
        return readText(file) === content;
    } catch (_) {
        return false;
    }
}

async function syncScenario() {
    const source = path('sync-src');
    const destination = path('sync-dst');
    const newDestination = path('sync-dst-new');
    GLib.mkdir_with_parents(source, 0o700);
    GLib.mkdir_with_parents(destination, 0o700);
    GLib.mkdir_with_parents(newDestination, 0o700);
    write(path('sync-src', 'a.txt'), 'one');

    const job = defaultJob({
        name: 'E2E Sync',
        type: JOB_TYPES.SYNC,
        source: {kind: 'local', path: source},
        destination: {kind: 'local', path: destination},
        trigger: {mode: 'realtime'},
        options: {maxDeleteMinimum: 10},
    });
    await client.saveJob(job);

    await waitFor(() => fileEquals(path('sync-dst', 'a.txt'), 'one'));
    ok('sync: initial copy through daemon');
    await sleep(500);

    write(path('sync-src', 'a.txt'), 'two');
    await waitFor(() => fileEquals(path('sync-dst', 'a.txt'), 'two'));
    ok('sync: real-time update');

    write(path('sync-src', 'sub', 'b.txt'), 'world');
    await waitFor(() => fileEquals(path('sync-dst', 'sub', 'b.txt'), 'world'));
    ok('sync: new directory and file');

    GLib.rename(path('sync-src', 'a.txt'), path('sync-src', 'c.txt'));
    await waitFor(() => fileEquals(path('sync-dst', 'c.txt'), 'two') &&
        !GLib.file_test(path('sync-dst', 'a.txt'), GLib.FileTest.EXISTS));
    ok('sync: rename propagated');

    deleteFile(path('sync-src', 'c.txt'));
    await waitFor(() => !GLib.file_test(path('sync-dst', 'c.txt'),
        GLib.FileTest.EXISTS));
    ok('sync: delete propagated');

    const updated = {
        ...job,
        destination: {kind: 'local', path: newDestination},
    };
    await client.saveJob(updated);
    await waitFor(() => fileEquals(path('sync-dst-new', 'sub', 'b.txt'), 'world'));
    ok('sync: destination change starts a new mirror');
}

async function backupScenario() {
    const source = path('backup-src');
    const destination = path('backup-dst');
    const restoreOne = path('restore-one');
    const restoreAll = path('restore-all');
    GLib.mkdir_with_parents(source, 0o700);
    GLib.mkdir_with_parents(destination, 0o700);
    GLib.mkdir_with_parents(restoreOne, 0o700);
    GLib.mkdir_with_parents(restoreAll, 0o700);
    write(path('backup-src', 'a.txt'), 'v1');
    write(path('backup-src', 'b.txt'), 'stay');

    const job = defaultJob({
        name: 'E2E Backup',
        type: JOB_TYPES.BACKUP,
        source: {kind: 'local', path: source},
        destination: {kind: 'local', path: destination},
        trigger: {mode: 'manual'},
        options: {notifyOnComplete: false},
        backup: {retentionDays: 0},
    });
    await client.saveJob(job);

    let run = await runJob(job.id);
    if (run.result !== 'success')
        throw new Error(`backup run 1: ${run.message}`);

    write(path('backup-src', 'a.txt'), 'v2');
    run = await runJob(job.id);
    if (run.result !== 'success')
        throw new Error(`backup run 2: ${run.message}`);

    deleteFile(path('backup-src', 'a.txt'));
    run = await runJob(job.id);
    if (run.result !== 'success')
        throw new Error(`backup run 3: ${run.message}`);

    const backupRoot = path('backup-dst', 'SaveMe', job.id);
    if (!GLib.file_test(GLib.build_filenamev([backupRoot, 'current', 'b.txt']),
        GLib.FileTest.EXISTS))
        throw new Error('backup current tree missing b.txt');
    ok('backup: current tree under SaveMe/<job-id>/current');

    const versions = await client.listVersions(job.id);
    if (versions.length < 2)
        throw new Error(`expected at least 2 versions, got ${versions.length}`);
    ok('backup: dated versions listed');

    const current = await client.listBackup(job.id, '', '', false);
    if (current.some(entry => entry.name === 'a.txt'))
        throw new Error('deleted file still in current backup');
    const latest = versions[0]?.name;
    const versionEntries = await client.listBackup(job.id, latest, '', false);
    if (!versionEntries.some(entry => entry.name === 'a.txt'))
        throw new Error('deleted file missing from version history');
    ok('backup: deleted file preserved in versions');

    await client.restore({
        jobId: job.id,
        version: latest,
        path: 'a.txt',
        target: restoreOne,
        dryRun: false,
    });
    if (!(await fileEquals(path('restore-one', 'a.txt'), 'v2')))
        throw new Error('deleted file restore did not produce v2');
    ok('backup: restore deleted file from dated version');

    await client.restore({
        jobId: job.id,
        version: '',
        path: '',
        target: restoreAll,
        dryRun: false,
    });
    if (!(await fileEquals(path('restore-all', 'b.txt'), 'stay')))
        throw new Error('current backup restore missing b.txt');
    ok('backup: restore current backup tree');
}

async function pauseResumeScenario() {
    const source = path('lifecycle-src');
    const destination = path('lifecycle-dst');
    GLib.mkdir_with_parents(source, 0o700);
    GLib.mkdir_with_parents(destination, 0o700);
    write(path('lifecycle-src', 'a.txt'), 'one');

    const job = defaultJob({
        name: 'E2E Lifecycle',
        type: JOB_TYPES.SYNC,
        source: {kind: 'local', path: source},
        destination: {kind: 'local', path: destination},
        trigger: {mode: 'realtime'},
        options: {maxDeleteMinimum: 10},
    });
    await client.saveJob(job);
    await waitFor(() => fileEquals(path('lifecycle-dst', 'a.txt'), 'one'));
    ok('lifecycle: initial sync');

    await client.pauseJob(job.id, true);
    await waitFor(async () => {
        const current = await client.getSnapshot();
        return current.jobs.find(item => item.id === job.id)?.state.status === 'paused';
    });
    ok('lifecycle: pause');

    write(path('lifecycle-src', 'b.txt'), 'two');
    await sleep(1500);
    if (GLib.file_test(path('lifecycle-dst', 'b.txt'), GLib.FileTest.EXISTS))
        throw new Error('paused job copied a file');
    ok('lifecycle: pause blocks realtime changes');

    await client.pauseJob(job.id, false);
    await waitFor(() => fileEquals(path('lifecycle-dst', 'b.txt'), 'two'));
    ok('lifecycle: resume flushes changes');

    let signals = 0;
    const unsubscribe = client.onSnapshot(() => {
        signals++;
    });
    await client.pauseAll(false);
    await sleep(1200);
    unsubscribe();
    if (signals === 0)
        throw new Error('daemon emitted no SnapshotChanged signal');
    ok('lifecycle: snapshot signal');

    await client.deleteJob(job.id);
}

async function multiSourceBackupScenario() {
    const sourceA = path('multi-a');
    const sourceB = path('multi-b');
    const destination = path('multi-dst');
    GLib.mkdir_with_parents(sourceA, 0o700);
    GLib.mkdir_with_parents(sourceB, 0o700);
    GLib.mkdir_with_parents(destination, 0o700);
    write(path('multi-a', 'a.txt'), 'alpha');
    write(path('multi-b', 'b.txt'), 'beta');
    const job = defaultJob({
        name: 'E2E Multi Backup',
        type: JOB_TYPES.BACKUP,
        sources: [
            {kind: 'local', path: sourceA},
            {kind: 'local', path: sourceB},
        ],
        destination: {kind: 'local', path: destination},
        trigger: {mode: 'interval', intervalMinutes: 60},
        options: {notifyOnComplete: false},
        backup: {retentionDays: 0},
    });
    const saved = await client.saveJob(job);
    await waitFor(() =>
        fileEquals(path('multi-dst', 'SaveMe', saved.id, 'current', 'multi-a', 'a.txt'), 'alpha') &&
        fileEquals(path('multi-dst', 'SaveMe', saved.id, 'current', 'multi-b', 'b.txt'), 'beta'));
    ok('backup: multi-source current tree');

    const manifest = path('multi-dst', 'SaveMe', saved.id, 'manifest.json');
    if (!GLib.file_test(manifest, GLib.FileTest.EXISTS))
        throw new Error('multi-source manifest missing');
    const inspected = await client.inspectBackup(path('multi-dst', 'SaveMe'));
    if (!inspected.jobs.some(entry => entry.job?.id === saved.id))
        throw new Error('multi-source job not recovered');
    ok('backup: manifest and recovery inventory');

    const shared = await client.saveJob(defaultJob({
        name: 'E2E Shared Container',
        type: JOB_TYPES.BACKUP,
        sources: [{kind: 'local', path: sourceA}],
        destination: {kind: 'local', path: destination},
        trigger: {mode: 'manual'},
    }));
    const sharedManifest = path('multi-dst', 'SaveMe', shared.id, 'manifest.json');
    if (!GLib.file_test(sharedManifest, GLib.FileTest.EXISTS))
        throw new Error('shared destination did not create its job folder');
    ok('backup: existing destination reused by a new job');
    await client.deleteJob(shared.id);

    const restoreTarget = path('multi-restore');
    GLib.mkdir_with_parents(restoreTarget, 0o700);
    await client.restore({
        jobId: saved.id,
        version: '',
        path: '',
        target: restoreTarget,
        dryRun: false,
    });
    await waitFor(() =>
        fileEquals(path('multi-restore', 'multi-a', 'a.txt'), 'alpha') &&
        fileEquals(path('multi-restore', 'multi-b', 'b.txt'), 'beta'));
    ok('backup: multi-source restore to a new local folder');
    await client.deleteJob(saved.id);
}

async function restartScenario() {
    const oldDaemon = daemon;
    await stopDaemon(oldDaemon);
    daemon = null;
    client.close();
    client = null;
    startDaemon();
    snapshot = await waitForDaemon();
    if (!snapshot.jobs.some(job => job.name === 'E2E Backup'))
        throw new Error('backup job missing after daemon restart');
    ok('daemon: state and jobs survive restart');
}

async function killScenario() {
    const oldDaemon = daemon;
    await killDaemon(oldDaemon);
    daemon = null;
    client.close();
    client = null;
    startDaemon();
    snapshot = await waitForDaemon();
    if (!snapshot.jobs.some(job => job.name === 'E2E Backup'))
        throw new Error('backup job missing after daemon kill');
    ok('daemon: kill -9 preserves jobs and state');
}

let snapshot = null;

async function main() {
    GLib.mkdir_with_parents(BASE, 0o700);
    startDaemon();
    snapshot = await waitForDaemon();

    try {
        await syncScenario();
        snapshot = await client.getSnapshot();
    } catch (e) {
        fail('sync scenario', e);
    }

    try {
        await backupScenario();
        snapshot = await client.getSnapshot();
    } catch (e) {
        fail('backup scenario', e);
    }

    try {
        await multiSourceBackupScenario();
        snapshot = await client.getSnapshot();
    } catch (e) {
        fail('multi-source backup scenario', e);
    }

    try {
        await restartScenario();
    } catch (e) {
        fail('restart scenario', e);
    }

    try {
        await pauseResumeScenario();
        snapshot = await client.getSnapshot();
    } catch (e) {
        fail('lifecycle scenario', e);
    }

    try {
        await killScenario();
    } catch (e) {
        fail('kill scenario', e);
    }

    if (client) {
        client.close();
        client = null;
    }
    if (daemon) {
        await stopDaemon(daemon);
        daemon = null;
    }
    if (GLib.getenv('SAVEME_E2E_ROOT') === null)
        removeRecursive(BASE);

    print(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) {
        print('\n--- daemon log ---');
        try {
            print(readText(LOG));
        } catch (_) {
            print('(no daemon log)');
        }
        return 1;
    }
    return 0;
}

try {
    system.exit(await main());
} catch (e) {
    printerr(`E2E fatal: ${e.message}`);
    if (e.stack)
        printerr(e.stack);
    try {
        printerr(readText(LOG));
    } catch (_) {
        // Ignore.
    }
    system.exit(1);
}
