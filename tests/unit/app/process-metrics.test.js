import GLib from 'gi://GLib';
import {
    cpuPercent,
    parseProcStat,
    parseProcStatus,
    readProcessMetrics,
} from '../../../app/observability/process-metrics.js';
import {assert, assertEqual, cleanup, suite, tempDir, test} from '../../harness.js';

export default suite('app/observability/process-metrics', [
    test('parses RSS, peak and virtual memory from proc status', () => {
        const parsed = parseProcStatus([
            'Name:\tsaveme-settings',
            'VmSize:\t     300 kB',
            'VmRSS:\t     100 kB',
            'VmHWM:\t     200 kB',
            'Other:\t     999 kB',
        ].join('\n'));
        assertEqual(parsed.rssBytes, 100 * 1024);
        assertEqual(parsed.peakRssBytes, 200 * 1024);
        assertEqual(parsed.virtualBytes, 300 * 1024);
        assertEqual(parseProcStatus('').rssBytes, 0);
    }),
    test('parses CPU ticks around a command name with spaces', () => {
        const fields = Array(20).fill('0');
        fields[0] = 'S';
        fields[11] = '12';
        fields[12] = '3';
        fields[19] = '99';
        const parsed = parseProcStat(`42 (name with ) paren) ${fields.join(' ')}`);
        assertEqual(parsed.utimeTicks, 12);
        assertEqual(parsed.stimeTicks, 3);
        assertEqual(parsed.startTicks, 99);
        assertEqual(parseProcStat('bad').utimeTicks, 0);
    }),
    test('computes CPU percentage from tick deltas', () => {
        const previous = {utimeTicks: 10, stimeTicks: 10, sampledAtMs: 1000};
        const current = {utimeTicks: 60, stimeTicks: 60, sampledAtMs: 2000};
        assertEqual(cpuPercent(previous, current), 100);
        assertEqual(cpuPercent(null, current), 0);
        assertEqual(cpuPercent(previous, {...current, sampledAtMs: 1000}), 0);
        assertEqual(cpuPercent(previous, {
            utimeTicks: 0,
            stimeTicks: 0,
            sampledAtMs: 2000,
        }), 0);
    }),
    test('reads real proc files and handles missing paths', () => {
        const root = tempDir('saveme-proc');
        try {
            const status = GLib.build_filenamev([root, 'status']);
            const stat = GLib.build_filenamev([root, 'stat']);
            GLib.file_set_contents(status, 'VmRSS:\t 64 kB\nVmHWM:\t 96 kB\n');
            GLib.file_set_contents(stat, '1 (gjs) S 0 0 0 0 0 0 0 0 0 0 7 8 0 0 0 0 0 0 0');
            const metrics = readProcessMetrics({
                statusPath: status,
                statPath: stat,
                nowMs: 123,
            });
            assertEqual(metrics.rssBytes, 64 * 1024);
            assertEqual(metrics.utimeTicks, 7);
            assertEqual(metrics.sampledAtMs, 123);
            assertEqual(readProcessMetrics({
                statusPath: `${root}/missing`,
                statPath: stat,
            }), null);
            const real = readProcessMetrics();
            assert(real.rssBytes > 0);
            assertEqual(parseProcStatus().rssBytes, 0);
        } finally {
            cleanup(root);
        }
    }),
]);
