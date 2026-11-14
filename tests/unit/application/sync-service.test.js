import {emptyStats} from '../../../src/domain/rclone-log.js';
import {assert, assertEqual, suite, test} from '../../harness.js';
import {makeJob, makeServices} from './fakes.js';

function syncContext() {
    const services = makeServices();
    services.files.addDir('/src');
    services.files.addDir('/dst');
    services.files.addFile('/src/a.txt');
    services.transfer.sizes.set('/src', {count: 2, bytes: 10});
    return services;
}

export default suite('application/sync-service', [
    test('full sync progress never moves backwards and finishes at 100', async () => {
        const ctx = syncContext();
        ctx.transfer.handler = (args, options) => {
            if (args[0] === 'sync' && !args.includes('--dry-run')) {
                options.onStats({...emptyStats(), bytes: 8, totalBytes: 10});
                options.onStats({...emptyStats(), bytes: 3, totalBytes: 10});
            }
            return {exitCode: 0, stats: emptyStats(), lastError: null, cancelled: false};
        };
        const percents = [];
        const run = await ctx.sync.runFull(makeJob('sync'), {
            onProgress: progress => percents.push(progress.percent),
        });
        assertEqual(run.result, 'success');
        for (let index = 1; index < percents.length; index++)
            assert(percents[index] >= percents[index - 1]);
        assertEqual(percents.at(-1), 100);
    }),
    test('cancellation during source sizing is reported as cancelled', async () => {
        const ctx = syncContext();
        ctx.transfer.sizeAsync = async () => {
            throw new Error('rclone size failed');
        };
        const run = await ctx.sync.runFull(makeJob('sync'), {
            cancellable: {is_cancelled: () => true},
        });
        assertEqual(run.result, 'cancelled');
    }),
    test('full sync runs a preflight and applies a guarded sync', async () => {
        const ctx = syncContext();
        const job = makeJob('sync', {options: {maxDeletePercent: 50, maxDeleteMinimum: 0}});
        const run = await ctx.sync.runFull(job);

        assertEqual(run.result, 'success');
        assertEqual(ctx.transfer.runs.length, 2);
        assert(ctx.transfer.runs[0].args.includes('--dry-run'));
        assert(ctx.transfer.runs[1].args.includes('--max-delete'));
        assertEqual(ctx.transfer.runs[1].args[0], 'sync');
        assertEqual(ctx.transfer.runs[1].args[1], '/src');
        assertEqual(ctx.transfer.runs[1].args[2], '/dst');
        assertEqual(ctx.runRepository.runs.length, 1);
        assert(ctx.files.writes.some(write => write.path === '/tmp/filters/job_test.txt'));
    }),
    test('full sync skips preflight for dry-run and force', async () => {
        const dry = syncContext();
        const dryRun = await dry.sync.runFull(makeJob('sync'), {dryRun: true});
        assertEqual(dryRun.result, 'success');
        assertEqual(dry.transfer.runs.length, 1);
        assert(dry.transfer.runs[0].args.includes('--dry-run'));

        const forced = syncContext();
        const forcedRun = await forced.sync.runFull(makeJob('sync'), {force: true});
        assertEqual(forcedRun.result, 'success');
        assertEqual(forced.transfer.runs.length, 1);
        assert(!forced.transfer.runs[0].args.includes('--dry-run'));
    }),
    test('full sync blocks when the preflight exceeds the delete guard', async () => {
        const ctx = syncContext();
        ctx.transfer.sizes.set('/src', {count: 10, bytes: 10});
        ctx.transfer.handler = args => {
            const stats = emptyStats();
            if (args.includes('--dry-run'))
                stats.deletes = 5;
            return {exitCode: 0, stats, lastError: null, cancelled: false};
        };
        const run = await ctx.sync.runFull(makeJob('sync', {
            options: {maxDeletePercent: 10, maxDeleteMinimum: 0},
        }));
        assertEqual(run.result, 'error');
        assert(/Delete guard/.test(run.message), run.message);
        assertEqual(ctx.transfer.runs.length, 1);
    }),
    test('full sync reports cancellation and transfer errors', async () => {
        const cancelled = syncContext();
        cancelled.transfer.handler = () => ({
            exitCode: 0,
            stats: emptyStats(),
            lastError: null,
            cancelled: true,
        });
        const cancelledRun = await cancelled.sync.runFull(makeJob('sync'), {force: true});
        assertEqual(cancelledRun.result, 'cancelled');

        const failed = syncContext();
        failed.transfer.handler = () => ({
            exitCode: 7,
            stats: emptyStats(),
            lastError: 'fatal transfer failure',
            cancelled: false,
        });
        const failedRun = await failed.sync.runFull(makeJob('sync'), {force: true});
        assertEqual(failedRun.result, 'error');
        assert(/fatal transfer failure/.test(failedRun.message));
    }),
    test('full sync fails before touching the destination when the source is missing', async () => {
        const ctx = makeServices();
        ctx.files.addDir('/dst');
        const run = await ctx.sync.runFull(makeJob('sync'));
        assertEqual(run.result, 'error');
        assert(/Source does not exist/.test(run.message), run.message);
        assertEqual(ctx.transfer.runs.length, 0);
    }),
    test('full sync refuses an empty source after a non-empty run', async () => {
        const ctx = syncContext();
        ctx.transfer.sizes.set('/src', {count: 0, bytes: 0});
        ctx.state.setJobState('job_test', {lastSourceFileCount: 5});
        const run = await ctx.sync.runFull(makeJob('sync'));
        assertEqual(run.result, 'error');
        assert(/Source is empty/.test(run.message), run.message);
        assertEqual(ctx.transfer.runs.length, 0);
    }),
    test('incremental sync copies upserts, deletes and prunes directories', async () => {
        const ctx = syncContext();
        ctx.files.addFile('/src/b.txt');
        ctx.state.setJobState('job_test', {lastSourceFileCount: 2});
        const changes = [
            {path: '/src/b.txt', kind: 'upsert'},
            {path: '/src/old.txt', kind: 'delete'},
        ];
        const run = await ctx.sync.runIncremental(makeJob('sync'), changes);
        assertEqual(run.result, 'success');
        assertEqual(ctx.transfer.runs.length, 3);
        assertEqual(ctx.transfer.runs[0].args[0], 'copy');
        assert(ctx.transfer.runs[0].args.includes('--no-traverse'));
        assertEqual(ctx.transfer.runs[1].args[0], 'delete');
        assertEqual(ctx.transfer.runs[2].args[0], 'rmdirs');
        assert(ctx.transfer.runs[1].args.includes('--filter-from'));
    }),
    test('incremental sync blocks deletes above the guard', async () => {
        const ctx = syncContext();
        ctx.state.setJobState('job_test', {lastSourceFileCount: 2});
        const run = await ctx.sync.runIncremental(makeJob('sync', {
            options: {maxDeletePercent: 0, maxDeleteMinimum: 0},
        }), [{path: '/src/old.txt', kind: 'delete'}]);
        assertEqual(run.result, 'error');
        assert(/Delete guard/.test(run.message), run.message);
        assertEqual(ctx.transfer.runs.length, 0);
    }),
    test('incremental sync returns noop when nothing survives planning', async () => {
        const ctx = syncContext();
        const run = await ctx.sync.runIncremental(makeJob('sync'), [
            {path: '/src/missing.txt', kind: 'upsert'},
        ]);
        assertEqual(run.result, 'noop');
        assertEqual(ctx.transfer.runs.length, 0);
        assertEqual(ctx.runRepository.runs.length, 1);
    }),
    test('large batches fall back to a full sync', async () => {
        const ctx = syncContext();
        const changes = [];
        for (let i = 0; i < 501; i++)
            changes.push({path: `/src/f${i}.txt`, kind: 'upsert'});
        const run = await ctx.sync.runIncremental(makeJob('sync'), changes);
        assertEqual(run.result, 'success');
        assertEqual(run.incremental, false);
        assertEqual(ctx.transfer.runs[0].args[0], 'sync');
    }),
    test('full sync handles remote and mixed targets with fast-list', async () => {
        const ctx = makeServices();
        ctx.files.addDir('/dst');
        ctx.transfer.sizes.set('drive:src', {count: 3, bytes: 3});
        const remoteSource = await ctx.sync.runFull(makeJob('sync', {
            source: {kind: 'remote', remote: 'drive', path: 'src'},
        }), {force: true});
        assertEqual(remoteSource.result, 'success');
        assert(ctx.transfer.runs[0].args.includes('--fast-list'));

        const both = makeServices();
        both.transfer.sizes.set('drive:src', {count: 3, bytes: 3});
        const bothRemote = await both.sync.runFull(makeJob('sync', {
            source: {kind: 'remote', remote: 'drive', path: 'src'},
            destination: {kind: 'remote', remote: 'drive', path: 'dst'},
        }), {force: true});
        assertEqual(bothRemote.result, 'success');
        assert(both.transfer.runs[0].args.includes('--fast-list'));
    }),
    test('full sync reports preflight cancellation and failure', async () => {
        const cancelled = syncContext();
        cancelled.transfer.handler = args => args.includes('--dry-run')
            ? {exitCode: 0, stats: emptyStats(), lastError: null, cancelled: true}
            : {exitCode: 0, stats: emptyStats(), lastError: null, cancelled: false};
        const cancelledRun = await cancelled.sync.runFull(makeJob('sync'));
        assertEqual(cancelledRun.result, 'cancelled');

        const failed = syncContext();
        failed.transfer.handler = args => args.includes('--dry-run')
            ? {exitCode: 7, stats: emptyStats(), lastError: 'preflight failed', cancelled: false}
            : {exitCode: 0, stats: emptyStats(), lastError: null, cancelled: false};
        const failedRun = await failed.sync.runFull(makeJob('sync'));
        assertEqual(failedRun.result, 'error');
        assert(/preflight failed/.test(failedRun.message));
    }),
    test('full sync maps max-delete transfer failures and handles unknown counts', async () => {
        const maxDelete = syncContext();
        maxDelete.transfer.handler = () => ({
            exitCode: 6,
            stats: emptyStats(),
            lastError: 'max delete exceeded',
            cancelled: false,
        });
        const maxRun = await maxDelete.sync.runFull(makeJob('sync'), {force: true});
        assertEqual(maxRun.result, 'error');
        assert(/Delete limit reached/.test(maxRun.message));

        const unknown = syncContext();
        unknown.transfer.sizeAsync = async () => ({count: Number.NaN, bytes: 0});
        const unknownRun = await unknown.sync.runFull(makeJob('sync'));
        assertEqual(unknownRun.result, 'success');
        assertEqual(unknown.transfer.runs.length, 1);
    }),
    test('full sync dry-run does not remember the source count', async () => {
        const ctx = syncContext();
        const run = await ctx.sync.runFull(makeJob('sync'), {dryRun: true});
        assertEqual(run.result, 'success');
        assertEqual(ctx.state.getJobState('job_test').lastSourceFileCount, 0);
    }),
    test('incremental sync handles directory upserts', async () => {
        const ctx = syncContext();
        ctx.files.addDir('/src/sub');
        ctx.state.setJobState('job_test', {lastSourceFileCount: 2});
        const run = await ctx.sync.runIncremental(makeJob('sync'), [
            {path: '/src/sub', kind: 'dir-upsert'},
        ]);
        assertEqual(run.result, 'success');
        assertEqual(ctx.transfer.runs.length, 1);
        assertEqual(ctx.transfer.runs[0].args[1], '/src/sub');
        assertEqual(ctx.transfer.runs[0].args[2], '/dst/sub');
    }),
    test('incremental sync reports step cancellation and errors', async () => {
        const cancelled = syncContext();
        cancelled.files.addFile('/src/a.txt');
        cancelled.transfer.handler = () => ({
            exitCode: 0, stats: emptyStats(), lastError: null, cancelled: true,
        });
        const cancelledRun = await cancelled.sync.runIncremental(makeJob('sync'), [
            {path: '/src/a.txt', kind: 'upsert'},
        ]);
        assertEqual(cancelledRun.result, 'cancelled');

        const failed = syncContext();
        failed.files.addFile('/src/a.txt');
        failed.transfer.handler = () => ({
            exitCode: 7, stats: emptyStats(), lastError: 'copy failed', cancelled: false,
        });
        const failedRun = await failed.sync.runIncremental(makeJob('sync'), [
            {path: '/src/a.txt', kind: 'upsert'},
        ]);
        assertEqual(failedRun.result, 'error');
        assert(/copy failed/.test(failedRun.message));
    }),
    test('incremental sync handles directory step failures', async () => {
        const ctx = syncContext();
        ctx.files.addDir('/src/sub');
        ctx.state.setJobState('job_test', {lastSourceFileCount: 2});
        ctx.transfer.handler = () => ({
            exitCode: 7, stats: emptyStats(), lastError: 'dir copy failed', cancelled: false,
        });
        const run = await ctx.sync.runIncremental(makeJob('sync'), [
            {path: '/src/sub', kind: 'dir-upsert'},
        ]);
        assertEqual(run.result, 'error');
        assert(/dir copy failed/.test(run.message));
    }),
    test('incremental sync reports delete cancellation and rmdirs warnings', async () => {
        const cancelled = syncContext();
        cancelled.state.setJobState('job_test', {lastSourceFileCount: 2});
        cancelled.transfer.handler = () => ({
            exitCode: 0, stats: emptyStats(), lastError: null, cancelled: true,
        });
        const cancelledRun = await cancelled.sync.runIncremental(makeJob('sync'), [
            {path: '/src/old.txt', kind: 'delete'},
        ]);
        assertEqual(cancelledRun.result, 'cancelled');

        const warned = syncContext();
        warned.state.setJobState('job_test', {lastSourceFileCount: 2});
        warned.transfer.handler = args => {
            if (args[0] === 'rmdirs')
                return {exitCode: 7, stats: emptyStats(), lastError: 'rmdirs failed', cancelled: false};
            return {exitCode: 0, stats: emptyStats(), lastError: null, cancelled: false};
        };
        const warnedRun = await warned.sync.runIncremental(makeJob('sync'), [
            {path: '/src/old.txt', kind: 'delete'},
        ]);
        assertEqual(warnedRun.result, 'success');
        assert(warned.logger.sink.some(item => /rmdirs failed/.test(item.message)));
    }),
    test('incremental sync rejects remote sources', async () => {
        const ctx = syncContext();
        const run = await ctx.sync.runIncremental(makeJob('sync', {
            source: {kind: 'remote', remote: 'drive', path: 'src'},
        }), [{path: '/src/a.txt', kind: 'upsert'}]);
        assertEqual(run.result, 'error');
        assert(/local source/.test(run.message));
        assertEqual(ctx.transfer.runs.length, 0);
    }),
    test('incremental sync accepts explicit run options', async () => {
        const ctx = syncContext();
        ctx.files.addFile('/src/a.txt');
        ctx.state.setJobState('job_test', {lastSourceFileCount: 2});
        let progressCalls = 0;
        const run = await ctx.sync.runIncremental(makeJob('sync'), [
            {path: '/src/a.txt', kind: 'upsert'},
        ], {
            force: true,
            cancellable: null,
            onProgress: () => {
                progressCalls++;
            },
            runId: 'run_explicit',
        });
        assertEqual(run.result, 'success');
        assertEqual(run.id, 'run_explicit');
        assertEqual(progressCalls, 0);
    }),
]);
