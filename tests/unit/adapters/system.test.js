import GLib from 'gi://GLib';
import {GioRawLogFactory} from '../../../src/adapters/gio/raw-log.js';
import {StateRunRepository} from '../../../src/adapters/persistence/run-repository.js';
import {SystemClock} from '../../../src/adapters/system/clock.js';
import {SystemPaths} from '../../../src/adapters/system/paths.js';
import {
    assert,
    assertEqual,
    cleanup,
    suite,
    tempDir,
    test,
} from '../../harness.js';

export default suite('adapters/system', [
    test('raw log writes lines and closes cleanly', () => {
        const root = tempDir('saveme-raw-log');
        try {
            const file = GLib.build_filenamev([root, 'nested', 'raw.jsonl']);
            const log = new GioRawLogFactory().create(file);
            log.write('line one');
            log.write('line two');
            log.close();
            const [ok, bytes] = GLib.file_get_contents(file);
            assert(ok);
            assertEqual(new TextDecoder().decode(bytes), 'line one\nline two\n');
            assertEqual(log.path, file);
        } finally {
            cleanup(root);
        }
    }),
    test('system clock provides milliseconds, ISO and Date', () => {
        const before = Date.now();
        const clock = new SystemClock();
        const millis = clock.nowMs();
        const iso = clock.nowIso();
        const date = clock.newDate();
        assert(millis >= before);
        assert(Date.parse(iso) >= before);
        assert(date instanceof Date);
    }),
    test('system clock schedules and cancels GLib timers', async () => {
        const clock = new SystemClock();
        let fired = 0;
        clock.setTimeout(() => {
            fired++;
        }, 0);
        clock.setTimeout(() => {
            fired += 100;
        }, 10);
        const cancelled = clock.setTimeout(() => {
            fired += 1000;
        }, 10);
        clock.clearTimeout(cancelled);
        clock.clearTimeout(null);
        clock.clearTimeout(0);
        clock.setTimeout(() => {
            fired++;
        }, -5);
        await new Promise(resolve => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        });
        assertEqual(fired, 102);
    }),
    test('system paths expose XDG-backed directories and joins', () => {
        const paths = new SystemPaths();
        assert(paths.filtersDir().endsWith('/saveme/filters'));
        assert(paths.logsDir('job_1').endsWith('/saveme/logs/job_1'));
        assert(paths.logsDir().endsWith('/saveme/logs'));
        assert(paths.tmpDir().endsWith('/saveme/tmp'));
        assertEqual(paths.join('/a', 'b'), '/a/b');
        assertEqual(paths.join(), '');
        assertEqual(paths.join('/a'), '/a');
    }),
    test('state run repository delegates record, get and list', () => {
        const calls = [];
        const repository = new StateRunRepository({
            state: {
                recordRun(run) {
                    calls.push(['record', run.id]);
                    return run;
                },
                getRun(jobId, runId) {
                    calls.push(['get', jobId, runId]);
                    return {jobId, id: runId};
                },
                listRuns(jobId, limit) {
                    calls.push(['list', jobId, limit]);
                    return [];
                },
            },
        });
        const run = {id: 'run_1'};
        assertEqual(repository.recordRun(run), run);
        assertEqual(repository.getRun('job_1', 'run_1').id, 'run_1');
        assertEqual(repository.listRuns('job_1', 5).length, 0);
        assertEqual(JSON.stringify(calls), JSON.stringify([
            ['record', 'run_1'],
            ['get', 'job_1', 'run_1'],
            ['list', 'job_1', 5],
        ]));
    }),
]);
