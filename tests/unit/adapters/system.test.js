import GLib from 'gi://GLib';
import {GioRawLog, GioRawLogFactory} from '../../../src/adapters/gio/raw-log.js';
import {Logger, readTextTail} from '../../../src/log.js';
import {RotatingFile} from '../../../src/adapters/system/rotating-file.js';
import {StateRunRepository} from '../../../src/adapters/persistence/run-repository.js';
import {SystemClock} from '../../../src/adapters/system/clock.js';
import {SystemPaths} from '../../../src/adapters/system/paths.js';
import {LogStore} from '../../../src/adapters/system/log-store.js';
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
            log.write('access_token=secret-value');
            log.close();
            const [ok, bytes] = GLib.file_get_contents(file);
            assert(ok);
            const text = new TextDecoder().decode(bytes);
            assert(text.includes('line one'));
            assert(!text.includes('secret-value'));
            assert(text.includes('[REDACTED]'));
            assertEqual(log.path, file);
            const custom = new GioRawLog(file, {maxBytes: 5, maxFiles: 0});
            custom.write('12345\n');
            custom.write('67890\n');
            custom.clear();
            custom.close();
            const [clearedOk, cleared] = GLib.file_get_contents(file);
            assert(clearedOk);
            assertEqual(new TextDecoder().decode(cleared), '');
            const direct = new GioRawLog(GLib.build_filenamev([root, 'direct.log']));
            direct.close();
        } finally {
            cleanup(root);
        }
    }),
    test('rotating file caps size and keeps numbered backups', () => {
        const root = tempDir('saveme-rotate');
        try {
            const path = GLib.build_filenamev([root, 'app.log']);
            const file = new RotatingFile({path, maxBytes: 10, maxFiles: 2});
            file.write('12345\n');
            file.write('67890\n');
            file.write('abc\n');
            file.write('zzzzzz\n');
            file.close();
            const read = name => {
                const path = GLib.build_filenamev([root, name]);
                if (!GLib.file_test(path, GLib.FileTest.EXISTS))
                    return '';
                const [ok, bytes] = GLib.file_get_contents(path);
                return ok ? new TextDecoder().decode(bytes) : '';
            };
            assertEqual(read('app.log'), 'zzzzzz\n');
            assertEqual(read('app.log.1'), '67890\nabc\n');
            assertEqual(read('app.log.2'), '12345\n');
            const reopened = new RotatingFile({path, maxBytes: 10, maxFiles: 2});
            reopened.clear();
            assertEqual(read('app.log'), '');
            assertEqual(read('app.log.1'), '');
            assertEqual(read('app.log.2'), '');
        } finally {
            cleanup(root);
        }
    }),
    test('rotating file handles defaults, truncation and path changes', () => {
        const root = tempDir('saveme-rotate-edges');
        try {
            const path = GLib.build_filenamev([root, 'first.log']);
            const file = new RotatingFile({path, maxBytes: 5, maxFiles: 0});
            file.write('');
            file.write('12345\n');
            file.write('67890\n');
            file.close();
            const [ok, bytes] = GLib.file_get_contents(path);
            assert(ok);
            assertEqual(new TextDecoder().decode(bytes), '67890\n');

            const second = GLib.build_filenamev([root, 'second.log']);
            file.setPath(second);
            file.write('second\n');
            file.clear({removeBackups: false});
            file.close();

            const empty = new RotatingFile();
            empty.write('ignored');
            empty.clear();
            empty.close();
        } finally {
            cleanup(root);
        }
    }),
    test('logger sanitizes secrets and tails sanitize existing files', () => {
        const root = tempDir('saveme-logger');
        try {
            const path = GLib.build_filenamev([root, 'daemon.log']);
            const logger = new Logger({
                name: 'test',
                filePath: path,
                echo: false,
                maxBytes: 1024,
            });
            logger.info('OAuth token = abc123', {password: 'hunter2'});
            logger.warn('Authorization: Bearer xyz.123');
            logger.close();
            const text = readTextTail(path, 20);
            assert(!text.includes('abc123'));
            assert(!text.includes('hunter2'));
            assert(!text.includes('xyz.123'));
            assert(text.includes('[REDACTED]'));
            const cleared = new Logger({name: 'test', filePath: path, echo: false});
            cleared.info('after clear');
            cleared.clear();
            cleared.info('fresh');
            cleared.close();
            assertEqual(readTextTail(path, 20).includes('after clear'), false);
            assertEqual(readTextTail(path, 20).includes('fresh'), true);
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
    test('log store inventories, sanitizes and removes managed files', () => {
        const root = tempDir('saveme-log-store');
        try {
            const logs = GLib.build_filenamev([root, 'logs']);
            const app = GLib.build_filenamev([logs, 'app.log']);
            const job = GLib.build_filenamev([logs, 'job_1']);
            GLib.mkdir_with_parents(job, 0o700);
            GLib.file_set_contents(GLib.build_filenamev([root, 'daemon.log']),
                'daemon\n');
            GLib.file_set_contents(GLib.build_filenamev([root, 'daemon.log.1']),
                'old daemon\n');
            GLib.file_set_contents(GLib.build_filenamev([job, 'run_1.log']),
                'access_token=secret\n');
            GLib.file_set_contents(GLib.build_filenamev([job, 'run_1.rclone.jsonl']),
                '{"raw":true}\n');
            GLib.file_set_contents(GLib.build_filenamev([logs, 'orphan.log']),
                'orphan\n');
            GLib.file_set_contents(app, 'app\n');
            GLib.file_set_contents(GLib.build_filenamev([root, 'state.json']),
                '{}\n');
            const store = new LogStore({
                statePath: root,
                logsPath: logs,
                daemonPath: GLib.build_filenamev([root, 'daemon.log']),
                appPath: app,
            });
            const entries = store.list();
            assertEqual(entries.filter(entry => entry.area === 'daemon').length, 2);
            assertEqual(entries.filter(entry => entry.area === 'jobs').length, 3);
            assertEqual(entries.filter(entry => entry.area === 'app').length, 1);
            assert(entries.every(entry => entry.path !==
                GLib.build_filenamev([root, 'state.json'])));
            assertEqual(entries.find(entry => entry.path.endsWith('orphan.log')).jobId, null);
            assertEqual(store._entry(`${root}/state.json`, {size: 1, mtimeMs: 1}).area,
                'state');
            assertEqual(store._entry('/outside/file.log', {size: 1, mtimeMs: 1}).area,
                'other');

            const sanitized = store.sanitize(entries);
            assertEqual(sanitized.changed, 1);
            assert(!readTextTail(GLib.build_filenamev([job, 'run_1.log']), 20)
                .includes('secret'));

            const removed = store.remove([
                ...entries.filter(entry => entry.area === 'jobs'),
                {path: `${root}/missing.log`, size: 0},
            ]);
            assertEqual(removed.deleted, 3);
            assertEqual(store.list().filter(entry => entry.area === 'jobs').length, 0);
        } finally {
            cleanup(root);
        }
    }),
    test('log store handles missing dirs, non-regular daemon paths and limits', () => {
        const root = tempDir('saveme-log-store-edges');
        try {
            const daemonDir = GLib.build_filenamev([root, 'daemon.log']);
            GLib.mkdir_with_parents(daemonDir, 0o700);
            const missingLogs = GLib.build_filenamev([root, 'missing-logs']);
            const store = new LogStore({
                statePath: root,
                logsPath: missingLogs,
                daemonPath: daemonDir,
                appPath: GLib.build_filenamev([missingLogs, 'app.log']),
            });
            assertEqual(store.list().length, 0);
            const log = GLib.build_filenamev([root, 'small.log']);
            GLib.file_set_contents(log, 'secret\n');
            const limited = new LogStore({
                statePath: root,
                logsPath: missingLogs,
                daemonPath: log,
                appPath: GLib.build_filenamev([missingLogs, 'app.log']),
                maxSanitizeBytes: 1,
            });
            assertEqual(limited.sanitize([
                {path: log, size: 7, kind: 'text'},
                {path: `${root}/gone.log`, size: 1, kind: 'text'},
            ]).files, 0);
            const defaults = new LogStore();
            assert(Array.isArray(defaults.list()));
        } finally {
            cleanup(root);
        }
    }),
    test('state run repository delegates record, get and list', () => {        const calls = [];
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
