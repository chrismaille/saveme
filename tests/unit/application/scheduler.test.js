import {Scheduler} from '../../../src/application/scheduler.js';
import {assert, assertEqual, suite, test} from '../../harness.js';
import {FakeClock, FakeLogger} from './fakes.js';

export default suite('application/scheduler', [
    test('starts, replaces and clears timers', () => {
        const clock = new FakeClock();
        const calls = [];
        const scheduler = new Scheduler({clock});
        scheduler.start('poll', 1000, () => calls.push('first'));
        assertEqual(scheduler.has('poll'), true);
        assertEqual(scheduler.size, 1);
        scheduler.start('poll', 1000, () => calls.push('second'));
        assertEqual(scheduler.size, 1);
        clock.tick(1000);
        assertEqual(JSON.stringify(calls), JSON.stringify(['second']));
        assertEqual(scheduler.has('poll'), false);
        scheduler.start('retry', 500, () => calls.push('retry'));
        scheduler.clear('retry');
        assertEqual(scheduler.size, 0);
        clock.tick(500);
        assertEqual(JSON.stringify(calls), JSON.stringify(['second']));
    }),
    test('clearAll stops every timer', () => {
        const clock = new FakeClock();
        const scheduler = new Scheduler({clock});
        scheduler.start('a', 100, () => {});
        scheduler.start('b', 200, () => {});
        assertEqual(scheduler.size, 2);
        scheduler.clearAll();
        assertEqual(scheduler.size, 0);
        assertEqual(clock.timerCount, 0);
    }),
    test('logs callback failures and continues', () => {
        const clock = new FakeClock();
        const logger = new FakeLogger();
        const scheduler = new Scheduler({clock, logger});
        scheduler.start('bad', 10, () => {
            throw new Error('boom');
        });
        clock.tick(10);
        assert(logger.sink.some(item => /Scheduled task bad failed/.test(item.message)));
        assertEqual(scheduler.size, 0);
    }),
]);
