import GLib from 'gi://GLib';
import {
    cpuPercentFromSamples,
    parseCpuStat,
    parseMeminfo,
    readSystemMetrics,
} from '../../../src/adapters/system/system-metrics.js';
import {assert, assertEqual, cleanup, suite, test} from '../../harness.js';

export default suite('adapters/system/metrics', [
    test('parses memory and CPU samples', () => {
        const memory = parseMeminfo([
            'MemTotal:       1000 kB',
            'MemFree:         200 kB',
            'MemAvailable:    400 kB',
        ].join('\n'));
        assertEqual(memory.totalBytes, 1000 * 1024);
        assertEqual(memory.usedBytes, 600 * 1024);
        const cpu = parseCpuStat('cpu  10 20 30 40 5 6 7 8 0 0\ncpu0 1 2 3 4');
        assertEqual(cpu.totalTicks, 126);
        assertEqual(cpu.idleTicks, 45);
        assertEqual(parseCpuStat('bad').totalTicks, 0);
        assertEqual(parseMeminfo('MemFree: 100 kB').totalBytes, 0);
        assertEqual(parseMeminfo('MemTotal: 100 kB').usedBytes, 100 * 1024);
        assertEqual(parseCpuStat('cpu 1 2 3').idleTicks, 0);
        assertEqual(parseCpuStat('cpu 1 x 3 4').totalTicks, 8);
        assertEqual(parseMeminfo('').totalBytes, 0);
    }),
    test('reads custom stat and memory paths with a previous sample', () => {
        const root = GLib.dir_make_tmp('saveme-system-metrics-XXXXXX');
        try {
            const stat = GLib.build_filenamev([root, 'stat']);
            const mem = GLib.build_filenamev([root, 'meminfo']);
            GLib.file_set_contents(stat, 'cpu 10 20 30 40 5 0 0 0\n');
            GLib.file_set_contents(mem, 'MemTotal: 1000 kB\nMemAvailable: 250 kB\n');
            const metrics = readSystemMetrics({
                statPath: stat,
                memPath: mem,
                previous: {idleTicks: 1, totalTicks: 1},
            });
            assert(metrics);
            assertEqual(metrics.memory.usedBytes, 750 * 1024);
            assert(metrics.cpuPercent > 0);
        } finally {
            cleanup(root);
        }
    }),
    test('returns null when the live files are unavailable', () => {
        assertEqual(readSystemMetrics({
            statPath: '/missing/stat',
            memPath: '/missing/meminfo',
        }), null);
    }),
    test('computes CPU percentage from counters', () => {
        assertEqual(cpuPercentFromSamples(
            {idleTicks: 100, totalTicks: 200},
            {idleTicks: 150, totalTicks: 300},
        ), 50);
        assertEqual(cpuPercentFromSamples(null, {}), 0);
        assertEqual(cpuPercentFromSamples(
            {idleTicks: 1, totalTicks: 1},
            {idleTicks: 1, totalTicks: 1},
        ), 0);
    }),
    test('reads the live proc metrics', () => {
        const metrics = readSystemMetrics();
        assert(metrics);
        assert(metrics.memory.totalBytes > 0);
        assert(metrics.cpuPercent >= 0);
    }),
]);
