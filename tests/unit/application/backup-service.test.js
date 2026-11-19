import {emptyStats} from '../../../src/domain/rclone-log.js';
import {assert, assertEqual, suite, test} from '../../harness.js';
import {makeJob, makeServices} from './fakes.js';

function backupContext({count = 2, retentionDays = 0} = {}) {
    const services = makeServices();
    services.files.addDir('/src');
    services.files.addDir('/dst');
    services.files.addFile('/src/a.txt');
    services.files.topLevel.set('/src', count);
    return {services, job: makeJob('backup', {backup: {retentionDays}})};
}

export default suite('application/backup-service', [
    test('full backup reports one monotonic progress bar across sources', async () => {
        const services = makeServices();
        services.files.addDir('/photos');
        services.files.addDir('/docs');
        services.files.addDir('/dst');
        services.transfer.sizes.set('/photos', {count: 2, bytes: 20});
        services.transfer.sizes.set('/docs', {count: 3, bytes: 30});
        services.transfer.handler = (args, options) => {
            if (args[0] === 'sync') {
                options.onStats({...emptyStats(), bytes: 6, totalBytes: 10});
                options.onStats({...emptyStats(), bytes: 2, totalBytes: 10});
            }
            return {exitCode: 0, stats: emptyStats(), lastError: null, cancelled: false};
        };
        const job = makeJob('backup', {
            sources: [
                {kind: 'local', path: '/photos'},
                {kind: 'local', path: '/docs'},
            ],
            trigger: {mode: 'interval', intervalMinutes: 60},
        });
        const percents = [];
        const phases = [];
        const run = await services.backup.runFull(job, {
            onProgress: progress => {
                percents.push(progress.percent);
                phases.push(progress.phase);
            },
        });
        assertEqual(run.result, 'success');
        for (let index = 1; index < percents.length; index++)
            assert(percents[index] >= percents[index - 1]);
        assert(phases.includes('checking'));
        assert(phases.includes('syncing'));
        assert(phases.includes('cleanup'));
        assert(phases.includes('done'));
        assert(percents.includes(95));
        assertEqual(percents.at(-1), 100);
    }),
    test('cancellation during source sizing is reported as cancelled', async () => {
        const {services, job} = backupContext();
        services.transfer.sizeAsync = async () => {
            throw new Error('rclone size failed');
        };
        const run = await services.backup.runFull(job, {
            cancellable: {is_cancelled: () => true},
        });
        assertEqual(run.result, 'cancelled');
    }),
    test('full backup writes current and a version directory', async () => {
        const {services, job} = backupContext();
        const run = await services.backup.runFull(job);
        assertEqual(run.result, 'success');
        assertEqual(services.transfer.runs.length, 1);
        const args = services.transfer.runs[0].args;
        assertEqual(args[0], 'sync');
        assertEqual(args[2], '/dst/SaveMe/job_test/current');
        assert(args.includes('--backup-dir'));
        assert(args[args.indexOf('--backup-dir') + 1].includes('/versions/'));
        assert(run.versionsDir.includes('/versions/'));
    }),
    test('multi-source backup writes one current/version subtree per source', async () => {
        const services = makeServices();
        services.files.addDir('/photos');
        services.files.addDir('/docs');
        services.files.addDir('/dst');
        services.transfer.sizes.set('/photos', {count: 2, bytes: 20});
        services.transfer.sizes.set('/docs', {count: 3, bytes: 30});
        const job = makeJob('backup', {
            sources: [
                {kind: 'local', path: '/photos'},
                {kind: 'local', path: '/docs'},
            ],
            trigger: {mode: 'interval', intervalMinutes: 60},
        });
        const run = await services.backup.runFull(job);
        assertEqual(run.result, 'success');
        assertEqual(services.transfer.runs.length, 2);
        assertEqual(services.transfer.runs[0].args[2],
            '/dst/SaveMe/job_test/current/photos');
        assertEqual(services.transfer.runs[1].args[2],
            '/dst/SaveMe/job_test/current/docs');
        assert(services.transfer.runs[0].args.includes('--backup-dir'));
        assert(services.transfer.runs[0].args[
            services.transfer.runs[0].args.indexOf('--backup-dir') + 1]
            .includes('/versions/'));
    }),
    test('full backup dry-run only adds --dry-run and skips cleanup', async () => {
        const {services, job} = backupContext({retentionDays: 30});
        const run = await services.backup.runFull(job, {dryRun: true});
        assertEqual(run.result, 'success');
        assertEqual(services.transfer.runs.length, 1);
        assert(services.transfer.runs[0].args.includes('--dry-run'));
    }),
    test('full backup cleans expired versions after a successful run', async () => {
        const {services, job} = backupContext({retentionDays: 1});
        services.transfer.handler = (args, options) => {
            if (args[0] === 'lsf') {
                options.onLine('20200101T000000-000-old', null);
                return {exitCode: 0, stats: emptyStats(), lastError: null, cancelled: false};
            }
            return {exitCode: 0, stats: emptyStats(), lastError: null, cancelled: false};
        };
        const run = await services.backup.runFull(job);
        assertEqual(run.result, 'success');
        assert(services.transfer.runs.some(item => item.args[0] === 'purge'));
    }),
    test('full backup reports cancelled and failed transfers', async () => {
        const cancelled = backupContext();
        cancelled.services.transfer.handler = () => ({
            exitCode: 0,
            stats: emptyStats(),
            lastError: null,
            cancelled: true,
        });
        const cancelledRun = await cancelled.services.backup.runFull(cancelled.job);
        assertEqual(cancelledRun.result, 'cancelled');

        const failed = backupContext();
        failed.services.transfer.handler = () => ({
            exitCode: 7,
            stats: emptyStats(),
            lastError: 'backup failed',
            cancelled: false,
        });
        const failedRun = await failed.services.backup.runFull(failed.job);
        assertEqual(failedRun.result, 'error');
        assert(/backup failed/.test(failedRun.message));
    }),
    test('backup refuses an empty source after a non-empty run', async () => {
        const {services, job} = backupContext({count: 0});
        services.state.setJobState('job_test', {lastSourceFileCount: 5});
        const run = await services.backup.runFull(job);
        assertEqual(run.result, 'error');
        assert(/source is empty/i.test(run.message), run.message);
        assert(/Source is empty/.test(run.technicalMessage), run.technicalMessage);
        assertEqual(services.transfer.runs.length, 0);
    }),
    test('aborts before rclone when the recreated source shrank', async () => {
        const {services, job} = backupContext({count: 4});
        services.transfer.sizes.set('/src', {count: 4, bytes: 40});
        services.state.setJobState('job_test', {
            lastResult: 'success',
            lastSourceFileCount: 11219,
        });
        const run = await services.backup.runFull(job);
        assertEqual(run.result, 'error');
        assert(/changed a lot/.test(run.message), run.message);
        assert(/Source changed/.test(run.technicalMessage), run.technicalMessage);
        assertEqual(services.transfer.runs.length, 0);
    }),
    test('reports the delete guard when rclone stops at max-delete', async () => {
        const {services, job} = backupContext();
        services.transfer.sizes.set('/src', {count: 100, bytes: 100});
        services.transfer.handler = (args, options) => {
            options.onLine('{"level":"error","msg":"--max-delete threshold reached"}', {
                level: 'error',
                msg: '--max-delete threshold reached',
            });
            return {
                exitCode: 7,
                stats: emptyStats(),
                lastError: 'Fatal error received - not attempting retries',
                cancelled: false,
            };
        };
        const run = await services.backup.runFull(job);
        assertEqual(run.result, 'error');
        assert(/Deletion blocked/.test(run.message), run.message);
        assert(/Delete guard/.test(run.technicalMessage), run.technicalMessage);
    }),
    test('incremental backup copies upserts and moves deletes to versions', async () => {
        const {services, job} = backupContext();
        services.files.addFile('/src/a.txt');
        const run = await services.backup.runIncremental(job, [
            {path: '/src/a.txt', kind: 'upsert'},
            {path: '/src/old.txt', kind: 'delete'},
        ]);
        assertEqual(run.result, 'success');
        assertEqual(services.transfer.runs.length, 3);
        assertEqual(services.transfer.runs[0].args[0], 'copy');
        assert(services.transfer.runs[0].args.includes('--backup-dir'));
        assertEqual(services.transfer.runs[1].args[0], 'move');
        assertEqual(services.transfer.runs[2].args[0], 'rmdirs');
        assert(run.versionsDir.includes('/versions/'));
    }),
    test('incremental multi-source backup is rejected', async () => {
        const {services} = backupContext();
        services.files.addDir('/src-b');
        const job = makeJob('backup', {
            sources: [
                {kind: 'local', path: '/src'},
                {kind: 'local', path: '/src-b'},
            ],
            trigger: {mode: 'interval', intervalMinutes: 60},
        });
        const run = await services.backup.runIncremental(job, [
            {path: '/src/a.txt', kind: 'upsert'},
        ]);
        assertEqual(run.result, 'error');
        assert(/Multi-source/.test(run.message));
    }),
    test('full backup survives unknown source counts', async () => {
        const {services, job} = backupContext();
        services.transfer.sizeAsync = async () => ({count: Number.NaN, bytes: 0});
        const run = await services.backup.runFull(job);
        assertEqual(run.result, 'success');
    }),
    test('incremental backup handles directory upserts', async () => {
        const {services, job} = backupContext();
        services.files.addDir('/src/sub');
        const run = await services.backup.runIncremental(job, [
            {path: '/src/sub', kind: 'dir-upsert'},
        ]);
        assertEqual(run.result, 'success');
        assertEqual(services.transfer.runs[0].args[0], 'copy');
        assert(services.transfer.runs[0].args.includes('--backup-dir'));
    }),
    test('incremental backup returns noop when nothing survives planning', async () => {
        const {services, job} = backupContext();
        const run = await services.backup.runIncremental(job, [
            {path: '/src/missing.txt', kind: 'upsert'},
        ]);
        assertEqual(run.result, 'noop');
        assertEqual(services.transfer.runs.length, 0);
    }),
    test('large backup batches fall back to a full run', async () => {
        const {services, job} = backupContext();
        const changes = [];
        for (let i = 0; i < 501; i++)
            changes.push({path: `/src/f${i}.txt`, kind: 'upsert'});
        const run = await services.backup.runIncremental(job, changes);
        assertEqual(run.result, 'success');
        assertEqual(run.incremental, false);
        assertEqual(services.transfer.runs[0].args[0], 'sync');
    }),
    test('full backup handles remote targets and fast-list', async () => {
        const services = makeServices();
        services.files.addDir('/dst');
        const job = makeJob('backup', {
            source: {kind: 'remote', remote: 'drive', path: 'src'},
        });
        const run = await services.backup.runFull(job, {force: true});
        assertEqual(run.result, 'success');
        assert(services.transfer.runs[0].args.includes('--fast-list'));

        const both = makeServices();
        const bothJob = makeJob('backup', {
            source: {kind: 'remote', remote: 'drive', path: 'src'},
            destination: {kind: 'remote', remote: 'drive', path: 'dst'},
        });
        const bothRun = await both.backup.runFull(bothJob, {force: true});
        assertEqual(bothRun.result, 'success');
        assert(both.transfer.runs[0].args.includes('--fast-list'));
    }),
    test('full backup tolerates version-listing and purge failures', async () => {
        const listFailed = backupContext({retentionDays: 1});
        listFailed.services.transfer.handler = args => args[0] === 'lsf'
            ? {exitCode: 7, stats: emptyStats(), lastError: 'cannot list', cancelled: false}
            : {exitCode: 0, stats: emptyStats(), lastError: null, cancelled: false};
        const listRun = await listFailed.services.backup.runFull(listFailed.job);
        assertEqual(listRun.result, 'success');
        assert(listFailed.services.logger.sink.some(item => /Cannot list versions/.test(item.message)));

        const purgeFailed = backupContext({retentionDays: 1});
        purgeFailed.services.transfer.handler = (args, options) => {
            if (args[0] === 'lsf') {
                options.onLine('20200101T000000-000-old', null);
                return {exitCode: 0, stats: emptyStats(), lastError: null, cancelled: false};
            }
            if (args[0] === 'purge')
                return {exitCode: 7, stats: emptyStats(), lastError: 'cannot purge', cancelled: false};
            return {exitCode: 0, stats: emptyStats(), lastError: null, cancelled: false};
        };
        const purgeRun = await purgeFailed.services.backup.runFull(purgeFailed.job);
        assertEqual(purgeRun.result, 'success');
        assert(purgeFailed.services.logger.sink.some(item => /cannot purge/.test(item.message)));
    }),
    test('incremental backup reports directory and upsert step failures', async () => {
        const dirCancelled = backupContext();
        dirCancelled.services.files.addDir('/src/sub');
        dirCancelled.services.transfer.handler = () => ({
            exitCode: 0, stats: emptyStats(), lastError: null, cancelled: true,
        });
        const dirRun = await dirCancelled.services.backup.runIncremental(dirCancelled.job, [
            {path: '/src/sub', kind: 'dir-upsert'},
        ]);
        assertEqual(dirRun.result, 'cancelled');

        const upsertFailed = backupContext();
        upsertFailed.services.files.addFile('/src/a.txt');
        upsertFailed.services.transfer.handler = () => ({
            exitCode: 7, stats: emptyStats(), lastError: 'copy failed', cancelled: false,
        });
        const upsertRun = await upsertFailed.services.backup.runIncremental(upsertFailed.job, [
            {path: '/src/a.txt', kind: 'upsert'},
        ]);
        assertEqual(upsertRun.result, 'error');
        assert(/copy failed/.test(upsertRun.message));
    }),
    test('incremental backup handles move cancellation, move errors and rmdirs warnings', async () => {
        const movedCancelled = backupContext();
        movedCancelled.services.transfer.handler = () => ({
            exitCode: 0, stats: emptyStats(), lastError: null, cancelled: true,
        });
        const cancelledRun = await movedCancelled.services.backup.runIncremental(movedCancelled.job, [
            {path: '/src/old.txt', kind: 'delete'},
        ]);
        assertEqual(cancelledRun.result, 'cancelled');

        const moveFailed = backupContext();
        moveFailed.services.transfer.handler = args => args[0] === 'move'
            ? {exitCode: 7, stats: emptyStats(), lastError: 'move failed', cancelled: false}
            : {exitCode: 0, stats: emptyStats(), lastError: null, cancelled: false};
        const moveRun = await moveFailed.services.backup.runIncremental(moveFailed.job, [
            {path: '/src/old.txt', kind: 'delete'},
        ]);
        assertEqual(moveRun.result, 'success');
        assert(moveFailed.services.logger.sink.some(item => /move failed/.test(item.message)));

        const rmdirsFailed = backupContext();
        rmdirsFailed.services.transfer.handler = args => args[0] === 'rmdirs'
            ? {exitCode: 7, stats: emptyStats(), lastError: 'rmdirs failed', cancelled: false}
            : {exitCode: 0, stats: emptyStats(), lastError: null, cancelled: false};
        const rmdirsRun = await rmdirsFailed.services.backup.runIncremental(rmdirsFailed.job, [
            {path: '/src/old.txt', kind: 'delete'},
        ]);
        assertEqual(rmdirsRun.result, 'success');
        assert(rmdirsFailed.services.logger.sink.some(item => /rmdirs failed/.test(item.message)));
    }),
    test('incremental backup rejects remote sources', async () => {
        const services = makeServices();
        const job = makeJob('backup', {
            source: {kind: 'remote', remote: 'drive', path: 'src'},
        });
        const run = await services.backup.runIncremental(job, [
            {path: '/src/a.txt', kind: 'upsert'},
        ]);
        assertEqual(run.result, 'error');
        assert(/local source/.test(run.message));
        assertEqual(services.transfer.runs.length, 0);
    }),
    test('incremental backup accepts explicit run options', async () => {
        const {services, job} = backupContext();
        services.files.addFile('/src/a.txt');
        let progressCalls = 0;
        const run = await services.backup.runIncremental(job, [
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
