import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {Logger} from '../../src/adapters/system/logger.js';
import {RcloneTransferEngine as Rclone, findRclone} from '../../src/adapters/rclone/transfer-engine.js';
import {StateStore} from '../../src/adapters/persistence/state-repository.js';
import {VolumeResolver} from '../../src/adapters/gio/volume-catalog.js';
import {backupCurrentFor, versionsRootFor} from '../../src/runner.js';
import {createJobRunner} from '../../src/composition/runner.js';
import {JOB_TYPES, defaultJob} from '../../src/jobs.js';
import {uniqueId} from '../../src/util.js';
import {
    assert,
    assertEqual,
    cleanup,
    findFiles,
    readFile,
    suite,
    tempDir,
    test,
    writeFile,
} from '../harness.js';

function createContext() {
    const root = tempDir('saveme-runner');
    const source = GLib.build_filenamev([root, 'src']);
    const dest = GLib.build_filenamev([root, 'dst']);
    GLib.mkdir_with_parents(source, 0o700);
    GLib.mkdir_with_parents(dest, 0o700);
    const logger = new Logger({name: 'runner-test', echo: false});
    const rclone = new Rclone({
        binary: findRclone(),
        configPath: GLib.build_filenamev([root, 'rclone.conf']),
        logger,
    });
    const state = new StateStore({logger});
    state.load();
    const volumes = new VolumeResolver();
    const runner = createJobRunner({rclone, volumes, logger, state});
    return {root, source, dest, logger, rclone, state, volumes, runner};
}

function makeJob(ctx, type = JOB_TYPES.SYNC, options = {}) {
    return defaultJob({
        id: uniqueId('job_test_'),
        name: `test-${type}`,
        type,
        source: {kind: 'local', path: ctx.source},
        destination: {kind: 'local', path: ctx.dest},
        destinationLayout: type === JOB_TYPES.SYNC ? 'direct' : 'saveMe',
        trigger: {mode: 'manual'},
        options: {
            maxDeletePercent: 10,
            maxDeleteMinimum: options.options?.maxDeleteMinimum ?? 10,
            ...options.options,
        },
        backup: {retentionDays: options.retentionDays ?? 0},
    });
}

function deleteFile(path) {
    const file = Gio.File.new_for_path(path);
    if (file.query_exists(null))
        file.delete(null);
}

function relativeFiles(root) {
    return findFiles(root).map(file => file.relative).sort();
}

export default suite('runner (integration)', [
    test('full sync mirrors files and applies changes', async () => {
        const ctx = createContext();
        try {
            writeFile(GLib.build_filenamev([ctx.source, 'a.txt']), 'one');
            writeFile(GLib.build_filenamev([ctx.source, 'sub', 'b.txt']), 'two');
            const job = makeJob(ctx);
            let run = await ctx.runner.runFull(job);
            assertEqual(run.result, 'success', `run failed: ${run.message}`);
            assertEqual(readFile(GLib.build_filenamev([ctx.dest, 'a.txt'])), 'one');
            assertEqual(readFile(GLib.build_filenamev([ctx.dest, 'sub', 'b.txt'])), 'two');

            writeFile(GLib.build_filenamev([ctx.source, 'a.txt']), 'ONE');
            writeFile(GLib.build_filenamev([ctx.source, 'c.txt']), 'three');
            deleteFile(GLib.build_filenamev([ctx.source, 'sub', 'b.txt']));
            run = await ctx.runner.runFull(job);
            assertEqual(run.result, 'success', `run failed: ${run.message}`);
            assertEqual(readFile(GLib.build_filenamev([ctx.dest, 'a.txt'])), 'ONE');
            assertEqual(readFile(GLib.build_filenamev([ctx.dest, 'c.txt'])), 'three');
            assert(!GLib.file_test(GLib.build_filenamev([ctx.dest, 'sub', 'b.txt']),
                GLib.FileTest.EXISTS));
        } finally {
            cleanup(ctx.root);
        }
    }),

    test('dry-run reports deletes without changing the destination', async () => {
        const ctx = createContext();
        try {
            writeFile(GLib.build_filenamev([ctx.source, 'a.txt']), 'one');
            const job = makeJob(ctx);
            await ctx.runner.runFull(job);
            writeFile(GLib.build_filenamev([ctx.dest, 'extra.txt']), 'extra');
            const run = await ctx.runner.runFull(job, {dryRun: true});
            assertEqual(run.result, 'success', `dry-run failed: ${run.message}`);
            assertEqual(run.stats.deletes, 1);
            assert(GLib.file_test(GLib.build_filenamev([ctx.dest, 'extra.txt']),
                GLib.FileTest.EXISTS));
        } finally {
            cleanup(ctx.root);
        }
    }),

    test('backup keeps previous versions', async () => {
        const ctx = createContext();
        try {
            writeFile(GLib.build_filenamev([ctx.source, 'a.txt']), 'v1');
            const job = makeJob(ctx, JOB_TYPES.BACKUP);
            let run = await ctx.runner.runFull(job);
            assertEqual(run.result, 'success', `v1 failed: ${run.message}`);
            writeFile(GLib.build_filenamev([ctx.source, 'a.txt']), 'v2');
            run = await ctx.runner.runFull(job);
            assertEqual(run.result, 'success', `v2 failed: ${run.message}`);
            writeFile(GLib.build_filenamev([ctx.source, 'a.txt']), 'v3');
            run = await ctx.runner.runFull(job);
            assertEqual(run.result, 'success', `v3 failed: ${run.message}`);
            assertEqual(readFile(GLib.build_filenamev([backupCurrentFor(job, ctx.dest), 'a.txt'])), 'v3');
            const versionsRoot = versionsRootFor(job, ctx.dest);
            const versions = findFiles(versionsRoot).map(file => readFile(file.path)).sort();
            assert(versions.includes('v1'), `versions: ${JSON.stringify(versions)}`);
            assert(versions.includes('v2'), `versions: ${JSON.stringify(versions)}`);
        } finally {
            cleanup(ctx.root);
        }
    }),

    test('backup moves deleted files to versions', async () => {
        const ctx = createContext();
        try {
            writeFile(GLib.build_filenamev([ctx.source, 'a.txt']), 'keep');
            writeFile(GLib.build_filenamev([ctx.source, 'b.txt']), 'remove');
            const job = makeJob(ctx, JOB_TYPES.BACKUP);
            let run = await ctx.runner.runFull(job);
            assertEqual(run.result, 'success', `run failed: ${run.message}`);
            deleteFile(GLib.build_filenamev([ctx.source, 'a.txt']));
            run = await ctx.runner.runFull(job);
            assertEqual(run.result, 'success', `run failed: ${run.message}`);
            const current = backupCurrentFor(job, ctx.dest);
            assert(!GLib.file_test(GLib.build_filenamev([current, 'a.txt']),
                GLib.FileTest.EXISTS));
            assertEqual(readFile(GLib.build_filenamev([current, 'b.txt'])), 'remove');
            const versionsRoot = versionsRootFor(job, ctx.dest);
            const versions = findFiles(versionsRoot).map(file => readFile(file.path));
            assert(versions.includes('keep'), `versions: ${JSON.stringify(versions)}`);
        } finally {
            cleanup(ctx.root);
        }
    }),

    test('delete guard aborts before touching the destination', async () => {
        const ctx = createContext();
        try {
            for (let i = 0; i < 20; i++)
                writeFile(GLib.build_filenamev([ctx.source, `f${i}.txt`]), String(i));
            const job = makeJob(ctx, JOB_TYPES.SYNC, {
                options: {maxDeleteMinimum: 0},
            });
            let run = await ctx.runner.runFull(job);
            assertEqual(run.result, 'success', `initial failed: ${run.message}`);
            for (let i = 0; i < 5; i++)
                deleteFile(GLib.build_filenamev([ctx.source, `f${i}.txt`]));
            run = await ctx.runner.runFull(job);
            assertEqual(run.result, 'error');
            assert(/Delete guard/.test(run.message), run.message);
            assertEqual(relativeFiles(ctx.dest).length, 20);
            run = await ctx.runner.runFull(job, {force: true});
            assertEqual(run.result, 'success', `force failed: ${run.message}`);
            assertEqual(relativeFiles(ctx.dest).length, 15);
        } finally {
            cleanup(ctx.root);
        }
    }),

    test('empty source guard prevents mass deletion', async () => {
        const ctx = createContext();
        try {
            writeFile(GLib.build_filenamev([ctx.source, 'a.txt']), 'a');
            writeFile(GLib.build_filenamev([ctx.source, 'b.txt']), 'b');
            const job = makeJob(ctx);
            let run = await ctx.runner.runFull(job);
            assertEqual(run.result, 'success', `initial failed: ${run.message}`);
            deleteFile(GLib.build_filenamev([ctx.source, 'a.txt']));
            deleteFile(GLib.build_filenamev([ctx.source, 'b.txt']));
            run = await ctx.runner.runFull(job);
            assertEqual(run.result, 'error');
            assert(/Source is empty/.test(run.message), run.message);
            assertEqual(relativeFiles(ctx.dest).length, 2);
        } finally {
            cleanup(ctx.root);
        }
    }),

    test('default filters exclude temporary and system files', async () => {
        const ctx = createContext();
        try {
            writeFile(GLib.build_filenamev([ctx.source, 'keep.txt']), 'keep');
            writeFile(GLib.build_filenamev([ctx.source, '.DS_Store']), 'junk');
            writeFile(GLib.build_filenamev([ctx.source, 'skip.tmp']), 'junk');
            writeFile(GLib.build_filenamev([ctx.source, '.saveme', 'secret']), 'junk');
            const job = makeJob(ctx);
            const run = await ctx.runner.runFull(job);
            assertEqual(run.result, 'success', `run failed: ${run.message}`);
            assertEqual(JSON.stringify(relativeFiles(ctx.dest)), JSON.stringify(['keep.txt']));
        } finally {
            cleanup(ctx.root);
        }
    }),

    test('incremental sync applies upserts and deletes', async () => {
        const ctx = createContext();
        try {
            writeFile(GLib.build_filenamev([ctx.source, 'a.txt']), 'one');
            writeFile(GLib.build_filenamev([ctx.source, 'sub', 'b.txt']), 'two');
            const job = makeJob(ctx);
            let run = await ctx.runner.runFull(job);
            assertEqual(run.result, 'success', `initial failed: ${run.message}`);

            writeFile(GLib.build_filenamev([ctx.source, 'a.txt']), 'ONE');
            writeFile(GLib.build_filenamev([ctx.source, 'c.txt']), 'three');
            deleteFile(GLib.build_filenamev([ctx.source, 'sub', 'b.txt']));
            run = await ctx.runner.runIncremental(job, [
                {path: GLib.build_filenamev([ctx.source, 'a.txt']), kind: 'upsert'},
                {path: GLib.build_filenamev([ctx.source, 'c.txt']), kind: 'upsert'},
                {path: GLib.build_filenamev([ctx.source, 'sub', 'b.txt']), kind: 'delete'},
            ]);
            assertEqual(run.result, 'success', `incremental failed: ${run.message}`);
            assertEqual(readFile(GLib.build_filenamev([ctx.dest, 'a.txt'])), 'ONE');
            assertEqual(readFile(GLib.build_filenamev([ctx.dest, 'c.txt'])), 'three');
            assert(!GLib.file_test(GLib.build_filenamev([ctx.dest, 'sub', 'b.txt']),
                GLib.FileTest.EXISTS));
        } finally {
            cleanup(ctx.root);
        }
    }),

    test('incremental sync handles directory delete', async () => {
        const ctx = createContext();
        try {
            writeFile(GLib.build_filenamev([ctx.source, 'dir', 'a.txt']), 'a');
            writeFile(GLib.build_filenamev([ctx.source, 'dir', 'b.txt']), 'b');
            const job = makeJob(ctx);
            let run = await ctx.runner.runFull(job);
            assertEqual(run.result, 'success', `initial failed: ${run.message}`);
            const dir = GLib.build_filenamev([ctx.source, 'dir']);
            Gio.File.new_for_path(GLib.build_filenamev([dir, 'a.txt'])).delete(null);
            Gio.File.new_for_path(GLib.build_filenamev([dir, 'b.txt'])).delete(null);
            Gio.File.new_for_path(dir).delete(null);
            run = await ctx.runner.runIncremental(job, [
                {path: dir, kind: 'dir-delete'},
            ]);
            assertEqual(run.result, 'success', `incremental failed: ${run.message}`);
            assert(!GLib.file_test(GLib.build_filenamev([ctx.dest, 'dir']),
                GLib.FileTest.EXISTS));
        } finally {
            cleanup(ctx.root);
        }
    }),

    test('incremental backup keeps versions', async () => {
        const ctx = createContext();
        try {
            writeFile(GLib.build_filenamev([ctx.source, 'a.txt']), 'v1');
            const job = makeJob(ctx, JOB_TYPES.BACKUP);
            let run = await ctx.runner.runFull(job);
            assertEqual(run.result, 'success', `initial failed: ${run.message}`);
            writeFile(GLib.build_filenamev([ctx.source, 'a.txt']), 'v2');
            run = await ctx.runner.runIncremental(job, [
                {path: GLib.build_filenamev([ctx.source, 'a.txt']), kind: 'upsert'},
            ]);
            assertEqual(run.result, 'success', `incremental failed: ${run.message}`);
            assertEqual(readFile(GLib.build_filenamev([backupCurrentFor(job, ctx.dest), 'a.txt'])), 'v2');
            const versionsRoot = versionsRootFor(job, ctx.dest);
            const versions = findFiles(versionsRoot).map(file => readFile(file.path));
            assert(versions.includes('v1'), `versions: ${JSON.stringify(versions)}`);
        } finally {
            cleanup(ctx.root);
        }
    }),

    test('incremental backup moves deleted files to versions', async () => {
        const ctx = createContext();
        try {
            writeFile(GLib.build_filenamev([ctx.source, 'a.txt']), 'keep');
            writeFile(GLib.build_filenamev([ctx.source, 'b.txt']), 'stay');
            const job = makeJob(ctx, JOB_TYPES.BACKUP);
            let run = await ctx.runner.runFull(job);
            assertEqual(run.result, 'success', `initial failed: ${run.message}`);
            const path = GLib.build_filenamev([ctx.source, 'a.txt']);
            deleteFile(path);
            run = await ctx.runner.runIncremental(job, [
                {path, kind: 'delete'},
            ]);
            assertEqual(run.result, 'success', `incremental failed: ${run.message}`);
            const current = backupCurrentFor(job, ctx.dest);
            assert(!GLib.file_test(GLib.build_filenamev([current, 'a.txt']),
                GLib.FileTest.EXISTS));
            assertEqual(readFile(GLib.build_filenamev([current, 'b.txt'])), 'stay');
            const versions = findFiles(versionsRootFor(job, ctx.dest))
                .map(file => readFile(file.path));
            assert(versions.includes('keep'), `versions: ${JSON.stringify(versions)}`);
        } finally {
            cleanup(ctx.root);
        }
    }),

    test('incremental delete guard aborts before touching the destination', async () => {
        const ctx = createContext();
        try {
            for (let i = 0; i < 20; i++)
                writeFile(GLib.build_filenamev([ctx.source, `f${i}.txt`]), String(i));
            const job = makeJob(ctx, JOB_TYPES.SYNC, {
                options: {maxDeleteMinimum: 0},
            });
            let run = await ctx.runner.runFull(job);
            assertEqual(run.result, 'success', `initial failed: ${run.message}`);
            const changes = [];
            for (let i = 0; i < 5; i++) {
                const path = GLib.build_filenamev([ctx.source, `f${i}.txt`]);
                deleteFile(path);
                changes.push({path, kind: 'delete'});
            }
            run = await ctx.runner.runIncremental(job, changes);
            assertEqual(run.result, 'error');
            assert(/Delete guard/.test(run.message), run.message);
            assertEqual(relativeFiles(ctx.dest).length, 20);
            run = await ctx.runner.runIncremental(job, changes, {force: true});
            assertEqual(run.result, 'success', `force failed: ${run.message}`);
            assertEqual(relativeFiles(ctx.dest).length, 15);
        } finally {
            cleanup(ctx.root);
        }
    }),

    test('missing source fails without touching destination', async () => {
        const ctx = createContext();
        try {
            writeFile(GLib.build_filenamev([ctx.source, 'a.txt']), 'a');
            const job = makeJob(ctx);
            let run = await ctx.runner.runFull(job);
            assertEqual(run.result, 'success', `initial failed: ${run.message}`);
            Gio.File.new_for_path(GLib.build_filenamev([ctx.source, 'a.txt'])).delete(null);
            Gio.File.new_for_path(ctx.source).delete(null);
            run = await ctx.runner.runFull(job);
            assertEqual(run.result, 'error');
            assert(/Source does not exist/.test(run.message), run.message);
            assertEqual(readFile(GLib.build_filenamev([ctx.dest, 'a.txt'])), 'a');
        } finally {
            cleanup(ctx.root);
        }
    }),
]);
