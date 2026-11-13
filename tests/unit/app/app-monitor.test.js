import {DEFAULT_MONITOR_LIMITS, AppMonitor} from '../../../app/observability/app-monitor.js';
import {assert, assertEqual, suite, test} from '../../harness.js';

const MIB = 1024 * 1024;

function sample({rss = 10, peak = null, ticks = 0, at = 0} = {}) {
    return {
        rssBytes: rss * MIB,
        peakRssBytes: (peak ?? rss) * MIB,
        utimeTicks: ticks,
        stimeTicks: 0,
        sampledAtMs: at,
    };
}

function fakeLogger() {
    return {
        sink: [],
        info(message, fields) {
            this.sink.push({level: 'info', message, fields});
        },
        warn(message, fields) {
            this.sink.push({level: 'warn', message, fields});
        },
    };
}

export default suite('app/observability/app-monitor', [
    test('samples memory, peak, growth and CPU on a timer', () => {
        const values = [
            sample({rss: 10, peak: 12, ticks: 0, at: 1000}),
            sample({rss: 20, peak: 21, ticks: 100, at: 2000}),
        ];
        const timers = [];
        const logger = fakeLogger();
        const monitor = new AppMonitor({
            reader: () => values.shift() || null,
            logger,
            intervalMs: 1000,
            limits: {
                memoryWarnBytes: 15 * MIB,
                growthWarnBytes: 5 * MIB,
                cpuWarnPercent: 50,
            },
            setTimeout(callback, delay) {
                timers.push({callback, delay});
                return timers.length;
            },
            clearTimeout() {},
        });
        const seen = [];
        monitor.onSample(metrics => seen.push(metrics));
        monitor.start();
        assertEqual(monitor.snapshot().reason, 'start');
        assertEqual(monitor.snapshot().budgetExceeded, false);
        assertEqual(monitor.snapshot().peakRssBytes, 12 * MIB);
        assertEqual(timers[0].delay, 1000);

        timers[0].callback();
        const after = monitor.snapshot();
        assertEqual(after.reason, 'periodic');
        assertEqual(after.rssBytes, 20 * MIB);
        assertEqual(after.growthBytes, 10 * MIB);
        assertEqual(after.cpuPercent, 100);
        assertEqual(after.budgetExceeded, true);
        assertEqual(seen.length, 2);
        assert(logger.sink.some(item => item.level === 'warn'));
        assertEqual(timers.length, 2);
    }),
    test('manual samples are bounded and unavailable metrics are logged', () => {
        const logger = fakeLogger();
        let calls = 0;
        const monitor = new AppMonitor({
            reader: () => {
                calls++;
                return calls === 1 ? sample({rss: 30}) : null;
            },
            logger,
            setTimeout: () => 1,
            clearTimeout: () => {},
        });
        const first = monitor.sampleNow('manual');
        assertEqual(first.samples, 1);
        const second = monitor.sampleNow('manual');
        assertEqual(second, null);
        assert(logger.sink.some(item => /unavailable/.test(item.message)));
        assertEqual(DEFAULT_MONITOR_LIMITS.memoryWarnBytes, 256 * MIB);
    }),
    test('reader exceptions and listener exceptions do not escape', () => {
        const logger = fakeLogger();
        let mode = 'throw';
        const monitor = new AppMonitor({
            reader: () => {
                if (mode === 'throw')
                    throw new Error('proc gone');
                return sample({rss: 1});
            },
            logger,
            setTimeout: () => 1,
            clearTimeout: () => {},
        });
        assertEqual(monitor.sampleNow('manual'), null);
        assert(logger.sink.some(item => /proc gone/.test(item.message)));
        mode = 'ok';
        monitor.onSample(() => {
            throw new Error('listener boom');
        });
        assert(monitor.sampleNow('manual'));
        assert(logger.sink.some(item => /listener boom/.test(item.message)));
    }),
    test('stop clears the scheduled timer', () => {
        let cleared = null;
        const monitor = new AppMonitor({
            reader: () => sample({rss: 1}),
            setTimeout: () => 42,
            clearTimeout: id => {
                cleared = id;
            },
        });
        monitor.start();
        monitor.stop();
        assertEqual(cleared, 42);
    }),
]);
