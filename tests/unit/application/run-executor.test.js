import {
    DeleteGuardError,
    DestinationUnavailableError,
    EmptySourceError,
    SourceChangedError,
    SourceUnavailableError,
} from '../../../src/domain/errors.js';
import {emptyStats} from '../../../src/domain/rclone-log.js';
import {assert, assertEqual, assertThrows, suite, test} from '../../harness.js';
import {
    makeExecutor,
    makeJob,
} from './fakes.js';

function context() {
    const executorContext = makeExecutor();
    const job = makeJob('sync');
    const ctx = executorContext.executor.beginRun(job, {
        dryRun: false,
        reason: 'manual',
        incremental: false,
    });
    return {...executorContext, job, ctx};
}

export default suite('application/run-executor', [
    test('handles parsed rclone lines at every level', () => {
        const {executor, ctx} = context();
        executor.handleParsed(ctx, {stats: {bytes: 1}});
        executor.handleParsed(ctx, {level: 'info'});
        executor.handleParsed(ctx, {
            level: 'critical',
            msg: ' fatal ',
            object: '/a/file.txt',
            size: 10,
        });
        assertEqual(ctx.currentFile, '/a/file.txt');
        assertEqual(ctx.lastError, ' fatal ');
        assert(ctx.logger.sink.some(item => item.level === 'error' && item.fields.size === 10));
        executor.handleParsed(ctx, {level: 'warning', msg: 'warn'});
        executor.handleParsed(ctx, {level: 'info', msg: 'info'});
        assert(ctx.logger.sink.some(item => item.level === 'warn'));
        assert(ctx.logger.sink.some(item => item.level === 'info' && item.message === 'info'));
    }),
    test('builds progress, tolerates state failures and calls onProgress', () => {
        const {executor, ctx} = context();
        let progress = null;
        ctx.onProgress = value => {
            progress = value;
        };
        ctx.currentFile = '/a/b.txt';
        executor.onStats(ctx, 'syncing', {
            bytes: 5,
            totalBytes: 10,
            transfers: 1,
            totalTransfers: 2,
            deletes: 0,
            errors: 0,
            speed: 1,
            eta: 2,
        });
        assertEqual(progress.percent, 50);
        assertEqual(progress.currentFile, 'b.txt');

        executor.state.updateProgress = () => {
            throw new Error('state unavailable');
        };
        executor.onStats(ctx, 'syncing', {
            bytes: 0,
            totalBytes: 0,
            transfers: 0,
            totalTransfers: 0,
            deletes: 0,
            errors: 0,
            speed: 0,
            eta: null,
        });
        assertEqual(progress.percent, 50);
    }),
    test('cleans --config from recorded arguments', () => {
        const {executor} = context();
        assertEqual(JSON.stringify(executor.cleanArgs(
            ['sync', '--config', '/tmp/rclone.conf', '--dry-run'])),
        JSON.stringify(['sync', '--dry-run']));
        assertEqual(JSON.stringify(executor.cleanArgs(['lsf', '/dst'])),
            JSON.stringify(['lsf', '/dst']));
    }),
    test('runs commands with callbacks, quiet mode and stat/error switches', async () => {
        const {executor, ctx, transfer} = context();
        const lines = [];
        transfer.handler = (args, options) => {
            options.onLine('raw line', null);
            options.onLine('{"level":"info","msg":"json"}', {
                level: 'info',
                msg: 'json',
                object: '/a/b',
            });
            options.onStats({bytes: 1});
            return {exitCode: 0, stats: emptyStats(), lastError: 'ignored', cancelled: false};
        };
        const result = await executor.runRclone(ctx, ['lsf', '/dst'], {
            phase: 'cleanup',
            quiet: true,
            mergeStats: false,
            trackError: false,
            trackExitCode: false,
            onDataLine: line => lines.push(line),
        });
        assertEqual(result.exitCode, 0);
        assertEqual(lines.length, 1);
        assertEqual(ctx.exitCode, null);
        assertEqual(ctx.lastError, null);
        assertEqual(ctx.operations.length, 1);
        assertEqual(executor.cleanArgs(ctx.operations[0].args).length, 2);
    }),
    test('beginRun tolerates state failures and honors provided run ids', async () => {
        const {executor, files, paths, rawLogFactory} = context();
        executor.state.setJobState = () => {
            throw new Error('cannot write');
        };
        const ctx = executor.beginRun(makeJob('sync'), {
            dryRun: true,
            reason: 'manual',
            incremental: false,
            runId: 'run_fixed',
        });
        assertEqual(ctx.runId, 'run_fixed');
        assert(ctx.logger.sink.some(item => item.level === 'warn'));
        assert(paths.logsDir('job_test').includes('job_test'));
        assertEqual(rawLogFactory.logs.length, 2);
        assert(files.writes.length >= 0);
    }),
    test('endRun survives repository and temp-file failures', () => {
        const {executor, ctx, files} = context();
        executor.runRepository.recordRun = () => {
            throw new Error('cannot record');
        };
        files.removeIfExists = () => {
            throw new Error('cannot remove');
        };
        ctx.tempFiles.push('/tmp/temp');
        const run = executor.endRun(ctx, 'success');
        assertEqual(run.result, 'success');
        assert(executor.logger.sink.some(item => item.level === 'error'));
    }),
    test('sourceCount handles exact, local and remote sources', async () => {
        const {executor, transfer, files} = context();
        transfer.sizes.set('/src', {count: 7, bytes: 70});
        transfer.sizes.set('drive:src', {count: 7, bytes: 70});
        assertEqual(await executor.sourceCount({}, {
            source: '/src', sourceIsLocal: true,
        }, {exact: true}), 7);
        assertEqual(transfer.lastSize.fastList, false);
        assertEqual(await executor.sourceCount({}, {
            source: 'drive:src', sourceIsLocal: false,
        }, {exact: true}), 7);
        assertEqual(transfer.lastSize.fastList, true);
        files.topLevel.set('/src', 4);
        assertEqual(await executor.sourceCount({}, {
            source: '/src', sourceIsLocal: true,
        }, {exact: false}), 4);
        assertEqual(await executor.sourceCount({}, {
            source: 'drive:src', sourceIsLocal: false,
        }, {exact: false}), null);
    }),
    test('sourceStats returns bytes and count for exact sizing', async () => {
        const {executor, transfer} = context();
        transfer.sizes.set('drive:src', {count: 7, bytes: 70});
        const stats = await executor.sourceStats({}, {
            source: 'drive:src', sourceIsLocal: false,
        }, {exact: true});
        assertEqual(stats.count, 7);
        assertEqual(stats.bytes, 70);
        transfer.sizeAsync = async () => ({});
        const empty = await executor.sourceStats({}, {
            source: 'drive:src', sourceIsLocal: false,
        }, {exact: true});
        assertEqual(empty.count, 0);
        assertEqual(empty.bytes, 0);
    }),
    test('checkDiskSpace blocks local destinations without room', async () => {
        const {executor, files} = context();
        executor.getSettings = () => ({minFreeSpaceMb: 0, diskSafetyPercent: 10});
        files.freeSpaceBytes = 100;
        const job = {type: 'sync'};
        const prep = {dest: '/dst', destIsLocal: true};
        const plan = executor.checkDiskSpace(job, prep, 50);
        assertEqual(plan.checked, true);
        assertEqual(plan.ok, true);
        files.freeSpaceBytes = 20;
        await assertThrows(() => executor.checkDiskSpace(job, prep, 50),
            /Not enough free disk space/);
        assertEqual(executor.checkDiskSpace(job, {
            dest: '/dst', destIsLocal: false,
        }, 50), null);
        assertEqual(executor.checkDiskSpace(job, prep, null), null);
        executor.transfer.about = () => ({free: 20});
        await assertThrows(() => executor.checkDiskSpace(job, {
            dest: 'drive:', destIsLocal: false,
        }, 50), /Not enough free disk space/);
        executor.transfer.about = () => ({free: 1000});
        assertEqual(executor.checkDiskSpace(job, {
            dest: 'drive:SaveMe/job', destIsLocal: false,
        }, 50).ok, true);
    }),
    test('checkEmptySource covers force, unknown counts and previous counts', async () => {
        const {executor, state} = context();
        executor.checkEmptySource({id: 'job_test'}, 0, true);
        executor.checkEmptySource({id: 'job_test'}, Number.NaN, false);
        executor.checkEmptySource({id: 'job_test'}, 1, false);
        state.setJobState('job_test', {lastSourceFileCount: 0});
        executor.checkEmptySource({id: 'job_test'}, 0, false);
        state.setJobState('job_test', {lastSourceFileCount: 3});
        await assertThrows(() => executor.checkEmptySource({id: 'job_test'}, 0, false),
            /Source is empty/);
    }),
    test('uses the last successful run as the source baseline', () => {
        const {executor, state, runRepository} = context();
        state.setJobState('job_test', {
            lastResult: 'error',
            lastSourceFileCount: 4,
        });
        runRepository.recordRun({
            id: 'run_ok', jobId: 'job_test', result: 'success',
            sourceFileCount: 11219, dryRun: false,
        });
        runRepository.recordRun({
            id: 'run_bad', jobId: 'job_test', result: 'error',
            sourceFileCount: 4, dryRun: false,
        });
        assertEqual(executor.lastSuccessfulSourceCount({id: 'job_test'}), 11219);
    }),
    test('blocks a drastically smaller source only when protection is on', async () => {
        const {executor, state} = context();
        state.setJobState('job_test', {
            lastResult: 'success',
            lastSourceFileCount: 11219,
        });
        await assertThrows(() => executor.checkSourceChange(
            {id: 'job_test'}, 4), /Source changed/);
        assertEqual(executor.checkSourceChange(
            {id: 'job_test'}, 6000), null);
        assertEqual(executor.checkSourceChange(
            {id: 'job_test'}, 4, {force: true}), null);
        assertEqual(executor.checkSourceChange(
            {id: 'job_test'}, 4, {enabled: false}), null);
        assertEqual(executor.checkSourceChange(
            {id: 'job_test'}, 4, {previousCount: 0}), null);
    }),
    test('maps a changed source to a readable explanation', () => {
        const {executor} = context();
        const message = executor.friendlyError(new SourceChangedError(4, 11219));
        assert(/changed a lot/.test(message), message);
        assert(/11219|11[.,]219/.test(message), message);
        assert(/restore|disable/i.test(message), message);
        assert(/source disk is unavailable/i.test(executor.friendlyError(
            new Error('Source disk is unavailable: Dados'))));
        assert(/destination disk is unavailable/i.test(executor.friendlyError(
            new Error('Destination disk is unavailable: Backup'))));
        assert(/Diagnósticos/.test(executor.friendlyError(
            new Error('Fatal error received - not attempting retries'))));
    }),
    test('quick source count and baseline refuse to throw on missing data', () => {
        const {executor, state, runRepository, files} = context();
        assertEqual(executor.quickSourceCount({
            source: 'drive:x', sourceIsLocal: false,
        }), null);
        files.topLevelEntryCount = () => {
            throw new Error('cannot list');
        };
        assertEqual(executor.quickSourceCount({
            source: '/src', sourceIsLocal: true,
        }), null);
        state.setJobState('job_test', {
            lastResult: 'error',
            lastSourceFileCount: 7,
        });
        runRepository.listRuns = () => {
            throw new Error('cannot list runs');
        };
        assertEqual(executor.lastSuccessfulSourceCount({id: 'job_test'}), 7);
        state.setJobState('job_test', {
            lastResult: 'error',
            lastSourceFileCount: 0,
        });
        assertEqual(executor.lastSuccessfulSourceCount({id: 'job_test'}), 0);
    }),
    test('friendlyError maps technical errors and falls back', () => {
        const {executor} = context();
        assertEqual(executor.friendlyError(new Error('plain')), 'plain');
        assert(/Source folder not found/.test(
            executor.friendlyError(new SourceUnavailableError('Source does not exist'))));
        assert(/Destination folder not found/.test(
            executor.friendlyError(new DestinationUnavailableError(
                'Destination does not exist'))));
        assert(/source is empty/i.test(
            executor.friendlyError(new EmptySourceError(2))));
        assert(/Deletion blocked/.test(
            executor.friendlyError(new DeleteGuardError(2, 1, 10, 10))));
        assert(/No internet connection/.test(executor.friendlyError(
            new Error('dial tcp: lookup graph.microsoft.com: server misbehaving'))));
        assert(/OneDrive/.test(executor.friendlyError(
            new Error('unable to get drive_id and drive_type'))));
        assert(/Not enough free space/.test(executor.friendlyError(
            new Error('no space left on device'))));
        assert(/Permission denied/.test(executor.friendlyError(
            new Error('permission denied'))));
        assertEqual(executor.friendlyError(null),
            'Operation failed. Check Logs & Debug for technical details.');
        assertEqual(executor.friendlyError({}), '[object Object]');
    }),
    test('smooths progress totals, speed and ETA without going backwards', () => {
        const {executor, ctx} = context();
        const first = executor.smoothProgress(ctx, {
            percent: 40,
            bytes: 40,
            totalBytes: 100,
            files: 4,
            totalFiles: 10,
            speed: 10,
            eta: 6,
        });
        assertEqual(first.percent, 40);
        assertEqual(first.eta, 6);
        const second = executor.smoothProgress(ctx, {
            percent: 10,
            bytes: 10,
            totalBytes: 50,
            files: 1,
            totalFiles: 5,
            speed: 0,
            eta: null,
        });
        assertEqual(second.bytes, 40);
        assertEqual(second.totalBytes, 100);
        assertEqual(second.percent, 40);
        assertEqual(second.speed, 10);
        assertEqual(second.eta, 6);
        const third = executor.smoothProgress(ctx, {
            percent: 60,
            bytes: 60,
            totalBytes: 100,
            files: 6,
            totalFiles: 10,
            speed: 20,
            eta: 2,
        });
        assert(third.percent >= 40);
        assert(third.speed > 10);
        assert(third.eta < 6);

        const filesCtx = executor.beginRun(makeJob('sync'), {
            dryRun: false,
            reason: 'manual',
            incremental: false,
        });
        const filesProgress = executor.smoothProgress(filesCtx, {
            percent: 0,
            bytes: 0,
            totalBytes: 0,
            files: 2,
            totalFiles: 4,
            speed: 5,
            eta: null,
        });
        assertEqual(filesProgress.percent, 50);

        const noTotalsCtx = executor.beginRun(makeJob('sync'), {
            dryRun: false,
            reason: 'manual',
            incremental: false,
        });
        const noTotals = executor.smoothProgress(noTotalsCtx, {
            percent: 20,
            bytes: 0,
            totalBytes: 0,
            files: 0,
            totalFiles: 0,
            speed: 0,
            eta: null,
        });
        assertEqual(noTotals.percent, 20);
        assertEqual(noTotals.eta, null);
    }),
    test('lists version directories and handles missing/failed roots', async () => {
        const {executor, ctx, transfer} = context();
        transfer.handler = (args, options) => {
            if (args[0] === 'lsf') {
                options.onLine('20260101T000000-000-old', null);
                options.onLine('20260102T000000-000-new/', null);
                return {exitCode: 0, stats: emptyStats(), lastError: null, cancelled: false};
            }
            return {exitCode: 0, stats: emptyStats(), lastError: null, cancelled: false};
        };
        assertEqual(JSON.stringify(await executor.listVersionDirs(ctx, '/dst', null)),
            JSON.stringify(['20260101T000000-000-old', '20260102T000000-000-new']));
        transfer.handler = () => ({
            exitCode: 3, stats: emptyStats(), lastError: null, cancelled: false,
        });
        assertEqual(JSON.stringify(await executor.listVersionDirs(ctx, '/dst', null)),
            JSON.stringify([]));
        transfer.handler = () => ({
            exitCode: 7, stats: emptyStats(), lastError: 'root missing', cancelled: false,
        });
        await assertThrows(() => executor.listVersionDirs(ctx, '/dst', null), /root missing/);
    }),
    test('cleans versions only when retention is enabled and skips missing roots', async () => {
        const {executor, ctx, job, transfer} = context();
        await executor.cleanupVersions(ctx, {...job, backup: {retentionDays: 0}}, '/dst');
        assertEqual(transfer.runs.length, 0);

        await executor.cleanupVersions(ctx,
            {...job, backup: {retentionDays: 1, keepForever: true}}, '/dst');
        assertEqual(transfer.runs.length, 0);

        transfer.handler = (args, options) => {
            if (args[0] === 'lsf') {
                options.onLine('20200101T000000-000-old', null);
                return {exitCode: 0, stats: emptyStats(), lastError: null, cancelled: false};
            }
            return {exitCode: 0, stats: emptyStats(), lastError: null, cancelled: false};
        };
        await executor.cleanupVersions(ctx, {...job, backup: {retentionDays: 1}}, '/dst');
        assert(transfer.runs.some(item => item.args[0] === 'purge'));

        transfer.handler = () => ({
            exitCode: 7, stats: emptyStats(), lastError: 'cannot list', cancelled: false,
        });
        await executor.cleanupVersions(ctx, {...job, backup: {retentionDays: 1}}, '/dst');
        assert(ctx.logger.sink.some(item => /Cannot list versions/.test(item.message)));
    }),
    test('countDeletes handles files, directories and missing directories', async () => {
        const {executor, ctx, transfer} = context();
        transfer.sizes.set('/dst/sub', {count: 2, bytes: 2});
        assertEqual(await executor.countDeletes({
            deletes: ['a'],
            dirDeletes: ['sub'],
        }, {dest: '/dst', destIsLocal: true}, ctx, null), 3);

        transfer.sizeAsync = async () => {
            throw new Error('directory not found');
        };
        assertEqual(await executor.countDeletes({
            deletes: [],
            dirDeletes: ['missing'],
        }, {dest: '/dst', destIsLocal: true}, ctx, null), 0);

        transfer.sizeAsync = async () => {
            throw new Error('permission denied');
        };
        await assertThrows(() => executor.countDeletes({
            deletes: [],
            dirDeletes: ['missing'],
        }, {dest: '/dst', destIsLocal: true}, ctx, null), /permission denied/);
    }),
    test('sourceCountForGuard uses state, transfer and tolerates state writes', async () => {
        const {executor, transfer, state} = context();
        state.setJobState('job_test', {lastSourceFileCount: 9});
        assertEqual(await executor.sourceCountForGuard(
            {id: 'job_test'}, {source: '/src', sourceIsLocal: true}, null), 9);
        state.setJobState('job_test', {lastSourceFileCount: 0});
        transfer.sizes.set('/src', {count: 4, bytes: 4});
        assertEqual(await executor.sourceCountForGuard(
            {id: 'job_test'}, {source: '/src', sourceIsLocal: true}, null), 4);
        executor.state.setJobState = () => {
            throw new Error('state failed');
        };
        assertEqual(await executor.sourceCountForGuard(
            {id: 'job_test'}, {source: '/src', sourceIsLocal: true}, null), 4);
    }),
    test('writes list and include filters, including empty lists', () => {
        const {executor, ctx, files, job} = context();
        const empty = executor.writeList(ctx, 'empty', []);
        assertEqual(files.writes.find(write => write.path === empty).text, '');
        const list = executor.writeList(ctx, 'list', ['a', 'b']);
        assertEqual(files.writes.find(write => write.path === list).text, 'a\nb\n');
        const include = executor.writeIncludeFilter(ctx, 'include', job, {
            files: ['a.txt'],
            dirs: ['dir'],
        });
        const text = files.writes.find(write => write.path === include).text;
        assert(/\+ \/a\.txt/.test(text));
        assert(/\+ \/dir\/\*\*/.test(text));
        assert(/- \*/.test(text));

        const selected = {
            ...job,
            filters: {exclude: ['private/**'], include: ['keep']},
        };
        const selectedFilter = executor.writeIncludeFilter(ctx, 'selected', selected, {
            files: ['keep/a.txt'],
        });
        const selectedText = files.writes
            .find(write => write.path === selectedFilter).text;
        assert(selectedText.includes('- private/**'));
        assert(selectedText.includes('+ /keep/a.txt'));
        assert(!selectedText.includes('- **'));
    }),
    test('filterFile and versionDir use the injected paths and clock', () => {
        const {executor, job, files} = context();
        const filter = executor.filterFile(job);
        assertEqual(filter, '/tmp/filters/job_test.txt');
        assert(files.writes.some(write => write.path === filter));
        const version = executor.versionDir(job, '/dst', {runId: 'run_abcdef'});
        assert(/20260102T030405-000-abcdef$/.test(version), version);
    }),
    test('runStep returns success, cancellation and failure results', async () => {
        const success = context();
        const successStep = await success.executor.runStep(success.ctx, ['lsf', '/dst']);
        assertEqual(successStep.run, null);
        assertEqual(successStep.result.exitCode, 0);

        const cancelled = context();
        cancelled.transfer.handler = () => ({
            exitCode: 0, stats: emptyStats(), lastError: null, cancelled: true,
        });
        const cancelledStep = await cancelled.executor.runStep(cancelled.ctx, ['lsf', '/dst']);
        assertEqual(cancelledStep.run.result, 'cancelled');

        const failed = context();
        failed.transfer.handler = () => ({
            exitCode: 7, stats: emptyStats(), lastError: 'step failed', cancelled: false,
        });
        const failedStep = await failed.executor.runStep(failed.ctx, ['lsf', '/dst']);
        assertEqual(failedStep.run.result, 'error');
        assert(/step failed/.test(failedStep.run.message));
    }),
    test('cleanupVersions logs purge failures and removal counts', async () => {
        const {executor, ctx, job, transfer} = context();
        transfer.handler = (args, options) => {
            if (args[0] === 'lsf') {
                options.onLine('20200101T000000-000-old', null);
                return {exitCode: 0, stats: emptyStats(), lastError: null, cancelled: false};
            }
            if (args[0] === 'purge')
                return {exitCode: 7, stats: emptyStats(), lastError: 'cannot purge', cancelled: false};
            return {exitCode: 0, stats: emptyStats(), lastError: null, cancelled: false};
        };
        await executor.cleanupVersions(ctx, {...job, backup: {retentionDays: 1}}, '/dst');
        assert(ctx.logger.sink.some(item => /cannot purge/.test(item.message)));

        transfer.handler = (args, options) => {
            if (args[0] === 'lsf') {
                options.onLine('20200101T000000-000-old', null);
                return {exitCode: 0, stats: emptyStats(), lastError: null, cancelled: false};
            }
            return {exitCode: 0, stats: emptyStats(), lastError: null, cancelled: false};
        };
        await executor.cleanupVersions(ctx, {...job, backup: {retentionDays: 1}}, '/dst');
        assert(ctx.logger.sink.some(item => /Removed 1 old version/.test(item.message)));
    }),
]);
