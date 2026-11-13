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
        await restartScenario();
    } catch (e) {
        fail('restart scenario', e);
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
