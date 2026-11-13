import {
    accumulateStats,
    emptyRcloneStats,
    emptyStats,
    exitCodeMessage,
    isSuccessExit,
    mergeStats,
    parseRcloneLine,
    progressFromStats,
    publicStats,
} from '../../../src/domain/rclone-log.js';
import {assert, assertEqual, suite, test} from '../../harness.js';
import {randomInt, seededRandom} from './helpers.js';

export default suite('domain/rclone-log', [
    test('isSuccessExit accepts 0 and 9 only', () => {
        assertEqual(isSuccessExit(0), true);
        assertEqual(isSuccessExit(9), true);
        assertEqual(isSuccessExit(1), false);
        assertEqual(isSuccessExit(-1), false);
    }),
    test('exitCodeMessage maps known and unknown codes', () => {
        assertEqual(exitCodeMessage(0), 'Success');
        assertEqual(exitCodeMessage(1), 'Syntax or usage error');
        assertEqual(exitCodeMessage(2), 'Error not otherwise categorised');
        assertEqual(exitCodeMessage(3), 'Directory not found');
        assertEqual(exitCodeMessage(4), 'File not found');
        assertEqual(exitCodeMessage(5), 'Temporary error (retries exhausted)');
        assertEqual(exitCodeMessage(6), 'Less serious error (some files failed)');
        assertEqual(exitCodeMessage(7), 'Fatal error');
        assertEqual(exitCodeMessage(8), 'Transfer exceeded maximum duration');
        assertEqual(exitCodeMessage(9), 'No files transferred');
        assertEqual(exitCodeMessage(42), 'rclone exited with code 42');
        assertEqual(exitCodeMessage(), 'rclone exited with code undefined');
    }),
    test('emptyStats and emptyRcloneStats have stable shapes', () => {
        const runner = emptyStats();
        assertEqual(runner.bytes, 0);
        assertEqual(runner.eta, null);
        assertEqual(runner.fatalError, false);
        assertEqual('retryError' in runner, false);
        const rclone = emptyRcloneStats();
        assertEqual(rclone.retryError, false);
        assertEqual(rclone.bytes, 0);
    }),
    test('parseRcloneLine parses JSON lines and ignores everything else', () => {
        assertEqual(parseRcloneLine('{"level":"info","msg":"ok"}').msg, 'ok');
        assertEqual(parseRcloneLine('not json'), null);
        assertEqual(parseRcloneLine('{bad json'), null);
        assertEqual(parseRcloneLine(''), null);
        assertEqual(parseRcloneLine(null), null);
    }),
    test('mergeStats updates known keys and skips null/undefined/unknown keys', () => {
        const target = {a: 1, b: 2};
        mergeStats(target, {});
        mergeStats(target, {a: 3, b: null, c: 4});
        mergeStats(target, {b: undefined, d: 5});
        assertEqual(JSON.stringify(target), JSON.stringify({a: 3, b: 2}));
    }),
    test('accumulateStats adds counters and preserves fallback values', () => {
        const target = emptyStats();
        accumulateStats(target, {
            bytes: 10,
            transfers: 2,
            speed: 100,
            eta: 5,
            fatalError: true,
        });
        assertEqual(target.bytes, 10);
        assertEqual(target.transfers, 2);
        assertEqual(target.speed, 100);
        assertEqual(target.eta, 5);
        assertEqual(target.fatalError, true);
        accumulateStats(target, {bytes: 5, speed: null, eta: undefined});
        assertEqual(target.bytes, 15);
        assertEqual(target.speed, 100);
        assertEqual(target.eta, 5);
        assertEqual(target.fatalError, true);
    }),
    test('publicStats normalizes numbers and booleans', () => {
        const stats = publicStats({
            bytes: '12',
            totalBytes: '100',
            transfers: '2',
            totalTransfers: '3',
            checks: '4',
            totalChecks: '5',
            deletes: '6',
            deletedDirs: '7',
            renames: '8',
            errors: '9',
            listed: '10',
            elapsedTime: '11',
            speed: '12',
            eta: undefined,
            fatalError: 1,
            retryError: 0,
        });
        assertEqual(stats.bytes, 12);
        assertEqual(stats.totalBytes, 100);
        assertEqual(stats.deletes, 6);
        assertEqual(stats.eta, null);
        assertEqual(stats.fatalError, true);
        assertEqual(stats.retryError, false);

        const nullEta = publicStats({eta: null});
        assertEqual(nullEta.eta, null);
        const zeroEta = publicStats({eta: 0});
        assertEqual(zeroEta.eta, 0);
    }),
    test('progressFromStats uses bytes when available and clamps percent', () => {
        const byBytes = progressFromStats({
            bytes: 50,
            totalBytes: 100,
            transfers: 1,
            totalTransfers: 2,
            deletes: 0,
            errors: 0,
            speed: 10,
            eta: 3,
        }, {
            jobId: 'job',
            runId: 'run',
            phase: 'syncing',
            currentPath: '/a/b/file.txt',
        });
        assertEqual(byBytes.percent, 50);
        assertEqual(byBytes.currentFile, 'file.txt');
        assertEqual(byBytes.currentPath, '/a/b/file.txt');
        assertEqual(byBytes.phase, 'syncing');

        const byFiles = progressFromStats({
            bytes: 0,
            totalBytes: 0,
            transfers: 1,
            totalTransfers: 2,
            deletes: 0,
            errors: 0,
            speed: 0,
            eta: null,
        });
        assertEqual(byFiles.percent, 50);
        assertEqual(byFiles.currentFile, null);
        assertEqual(byFiles.currentPath, null);

        const empty = progressFromStats({
            bytes: 0,
            totalBytes: 0,
            transfers: 0,
            totalTransfers: 0,
            deletes: 0,
            errors: 0,
            speed: 0,
            eta: null,
        });
        assertEqual(empty.percent, 0);

        const clamped = progressFromStats({
            bytes: 200,
            totalBytes: 100,
            transfers: 0,
            totalTransfers: 0,
            deletes: 0,
            errors: 0,
            speed: 0,
            eta: null,
        });
        assertEqual(clamped.percent, 100);
    }),
    test('property: progress percent stays between 0 and 100', () => {
        const random = seededRandom(0x9109);
        for (let i = 0; i < 300; i++) {
            const stats = {
                bytes: randomInt(random, 0, 1_000_000),
                totalBytes: randomInt(random, 0, 1_000_000),
                transfers: randomInt(random, 0, 1000),
                totalTransfers: randomInt(random, 0, 1000),
                deletes: 0,
                errors: 0,
                speed: 0,
                eta: null,
            };
            const progress = progressFromStats(stats);
            assert(progress.percent >= 0 && progress.percent <= 100, String(progress.percent));
        }
    }),
]);
