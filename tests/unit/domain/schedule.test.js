import {
    intervalMs,
    isRunOverdue,
    isValidTime,
    nextRunDelay,
    parseTime,
    previousRunMs,
    triggerLabel,
} from '../../../src/domain/schedule.js';
import {sunsetTime} from '../../../src/domain/sun.js';
import {assert, assertEqual, suite, test} from '../../harness.js';

const NOW = new Date(2026, 10, 14, 12, 0, 0).getTime();

export default suite('domain/schedule', [
    test('interval delays use minutes and clamp invalid values', () => {
        assertEqual(intervalMs({intervalMinutes: 60}), 3_600_000);
        assertEqual(intervalMs(), 3_600_000);
        assertEqual(intervalMs({}), 3_600_000);
        assertEqual(intervalMs({intervalMinutes: null}), 3_600_000);
        assertEqual(intervalMs({intervalMinutes: ''}), 3_600_000);
        assertEqual(intervalMs({intervalMinutes: 'nope'}), 3_600_000);
        assertEqual(intervalMs({intervalMinutes: 0}), 60_000);
        assertEqual(intervalMs({intervalMinutes: -15}), 60_000);
        assertEqual(intervalMs({intervalMinutes: 0.4}), 60_000);
        assertEqual(nextRunDelay({mode: 'interval', intervalMinutes: 15}), 900_000);
        assertEqual(nextRunDelay({mode: 'manual'}), null);
        assertEqual(nextRunDelay({mode: 'startup'}), null);
        assertEqual(nextRunDelay({mode: 'unknown'}), null);
        assertEqual(nextRunDelay(), null);
    }),
    test('weekly and monthly schedules use local time', () => {
        const weekly = nextRunDelay({
            mode: 'weekly',
            dayOfWeek: 6,
            time: '09:30',
        }, NOW);
        const weeklyDate = new Date(NOW + weekly);
        assertEqual(weeklyDate.getDay(), 6);
        assertEqual(weeklyDate.getDate(), 21);
        assertEqual(weeklyDate.getHours(), 9);
        assertEqual(weeklyDate.getMinutes(), 30);

        const sameDay = nextRunDelay({
            mode: 'weekly',
            dayOfWeek: 6,
            time: '18:00',
        }, NOW);
        assertEqual(sameDay, 6 * 60 * 60_000);

        const monthly = nextRunDelay({
            mode: 'monthly',
            dayOfMonth: 1,
            time: '03:00',
        }, NOW);
        const monthlyDate = new Date(NOW + monthly);
        assertEqual(monthlyDate.getDate(), 1);
        assertEqual(monthlyDate.getMonth(), 11);

        const clampedLow = nextRunDelay({
            mode: 'weekly',
            dayOfWeek: -3,
            time: '09:30',
        }, NOW);
        const lowDate = new Date(NOW + clampedLow);
        assertEqual(lowDate.getDay(), 0);
        assertEqual(lowDate.getDate(), 15);
        const clampedHigh = nextRunDelay({
            mode: 'weekly',
            dayOfWeek: 99,
            time: '18:00',
        }, NOW);
        assertEqual(clampedHigh, 6 * 60 * 60_000);

        const defaultWeekly = nextRunDelay({mode: 'weekly'}, NOW);
        const defaultWeeklyDate = new Date(NOW + defaultWeekly);
        assertEqual(defaultWeeklyDate.getDay(), 1);
        assertEqual(defaultWeeklyDate.getHours(), 18);
        const defaultMonthly = nextRunDelay({mode: 'monthly'}, NOW);
        const defaultMonthlyDate = new Date(NOW + defaultMonthly);
        assertEqual(defaultMonthlyDate.getDate(), 1);
        assertEqual(defaultMonthlyDate.getMonth(), 11);
    }),
    test('monthly schedules clamp the day to the last day of short months', () => {
        const january = new Date(2026, 0, 31, 19, 0, 0).getTime();
        const delay = nextRunDelay({
            mode: 'monthly',
            dayOfMonth: 31,
            time: '18:00',
        }, january);
        const next = new Date(january + delay);
        assertEqual(next.getMonth(), 1);
        assertEqual(next.getDate(), 28);
        assertEqual(next.getHours(), 18);

        const low = nextRunDelay({
            mode: 'monthly',
            dayOfMonth: 0,
            time: '18:00',
        }, january);
        assertEqual(new Date(january + low).getDate(), 1);
        const high = nextRunDelay({
            mode: 'monthly',
            dayOfMonth: 99,
            time: '18:00',
        }, new Date(2026, 10, 14, 12, 0, 0).getTime());
        assertEqual(new Date(new Date(2026, 10, 14, 12, 0, 0).getTime() + high).getDate(), 30);
    }),
    test('interval units and dusk roll over correctly', () => {
        assertEqual(nextRunDelay({mode: 'interval', intervalMinutes: 2880}), 2 * 86_400_000);
        const evening = new Date(2026, 10, 14, 20, 0, 0).getTime();
        const dusk = nextRunDelay({mode: 'dusk'}, evening);
        const next = new Date(evening + dusk);
        assertEqual(next.getDate(), 15);
        assertEqual(next.getHours(), 18);
        const configured = nextRunDelay({mode: 'dusk', time: '23:30'}, evening);
        assertEqual(new Date(evening + configured).getDate(), 14);
        assertEqual(nextRunDelay({mode: 'realtime'}), null);
    }),
    test('dusk follows automatic sunset coordinates', () => {
        const noon = new Date(2026, 10, 21, 12, 0, 0);
        const trigger = {
            mode: 'dusk',
            time: '20:00',
            duskAutomatic: true,
            duskLatitude: -23.5505,
            duskLongitude: -46.6333,
        };
        const sunset = sunsetTime(trigger.duskLatitude, trigger.duskLongitude, noon);
        const [hours, minutes] = sunset.split(':').map(Number);
        const expected = new Date(2026, 10, 21, hours, minutes, 0).getTime() -
            noon.getTime();
        assertEqual(nextRunDelay(trigger, noon.getTime()), expected);
        assertEqual(triggerLabel(trigger), `At dusk (${sunset})`);
    }),
    test('dusk falls back when automatic coordinates are unusable', () => {
        assertEqual(triggerLabel({mode: 'dusk', time: '21:00',
            duskAutomatic: true, duskLatitude: 'x', duskLongitude: -46.6}),
        'At dusk (21:00)');
        assertEqual(triggerLabel({mode: 'dusk', time: '21:00',
            duskAutomatic: true, duskLatitude: -23.5, duskLongitude: NaN}),
        'At dusk (21:00)');
        assertEqual(triggerLabel({mode: 'dusk', time: '21:00',
            duskAutomatic: true, duskLatitude: 90, duskLongitude: 0}),
        'At dusk (21:00)');
    }),
    test('dusk defaults to 18:00 and time parsing is defensive', () => {
        const delay = nextRunDelay({mode: 'dusk'}, NOW);
        assertEqual(new Date(NOW + delay).getHours(), 18);
        assertEqual(JSON.stringify(parseTime('bad')), JSON.stringify({hours: 18, minutes: 0}));
        assertEqual(JSON.stringify(parseTime()), JSON.stringify({hours: 18, minutes: 0}));
        assertEqual(JSON.stringify(parseTime('25:90')), JSON.stringify({hours: 18, minutes: 0}));
        assertEqual(JSON.stringify(parseTime('07:45')), JSON.stringify({hours: 7, minutes: 45}));
        assert(isValidTime('00:00'));
        assert(isValidTime('23:59'));
        assert(!isValidTime('24:00'));
        assert(!isValidTime('9:5'));
        assert(!isValidTime(''));
    }),
    test('previous occurrences catch up missed schedules', () => {
        const weekly = previousRunMs({mode: 'weekly', dayOfWeek: 6, time: '09:30'}, NOW);
        assertEqual(new Date(weekly).getDate(), 14);
        assertEqual(isRunOverdue({mode: 'weekly', dayOfWeek: 6, time: '09:30'},
            NOW - 7 * 86_400_000, NOW), true);
        assertEqual(isRunOverdue({mode: 'weekly', dayOfWeek: 6, time: '09:30'},
            NOW - 60 * 60_000, NOW), false);

        const pendingToday = previousRunMs({mode: 'weekly', dayOfWeek: 6, time: '18:00'}, NOW);
        assertEqual(new Date(pendingToday).getDate(), 7);
        const monday = previousRunMs({mode: 'weekly', dayOfWeek: 1, time: '09:30'}, NOW);
        assertEqual(new Date(monday).getDate(), 9);

        const monthly = previousRunMs({mode: 'monthly', dayOfMonth: 20, time: '03:00'}, NOW);
        assertEqual(new Date(monthly).getMonth(), 9);
        assertEqual(new Date(monthly).getDate(), 20);
        const earlyMonth = previousRunMs({mode: 'monthly', dayOfMonth: 1, time: '03:00'}, NOW);
        assertEqual(new Date(earlyMonth).getMonth(), 10);

        const evening = new Date(2026, 10, 14, 20, 0, 0).getTime();
        assertEqual(new Date(previousRunMs({mode: 'dusk'}, evening)).getDate(), 14);
        assertEqual(new Date(previousRunMs({mode: 'dusk'}, NOW)).getDate(), 13);

        assertEqual(previousRunMs({mode: 'interval'}, NOW), null);
        assertEqual(previousRunMs({mode: 'manual'}, NOW), null);
        assertEqual(previousRunMs({mode: 'startup'}, NOW), null);
        assertEqual(previousRunMs(), null);
        const defaultWeekly = previousRunMs({mode: 'weekly'}, NOW);
        assertEqual(new Date(defaultWeekly).getDay(), 1);
        assertEqual(new Date(defaultWeekly).getHours(), 18);
        const defaultMonthly = previousRunMs({mode: 'monthly'}, NOW);
        assertEqual(new Date(defaultMonthly).getMonth(), 10);
        assertEqual(new Date(defaultMonthly).getDate(), 1);
        assertEqual(new Date(previousRunMs({mode: 'dusk', time: '19:00'}, NOW)).getDate(), 13);
        assertEqual(isRunOverdue({mode: 'weekly'}, NaN, NOW), false);
        assertEqual(isRunOverdue({mode: 'manual'}, 0, NOW), false);
        assertEqual(isRunOverdue({mode: 'manual'}, 0), false);
    }),
    test('labels describe the configured schedule', () => {
        assertEqual(triggerLabel({mode: 'startup'}), 'At computer startup');
        assertEqual(triggerLabel({mode: 'weekly', dayOfWeek: 1, time: '08:00'}),
            'Monday at 08:00');
        assertEqual(triggerLabel({mode: 'weekly'}), 'Monday at 18:00');
        assertEqual(triggerLabel({mode: 'monthly', dayOfMonth: 10, time: '09:00'}),
            'Day 10 at 09:00');
        assertEqual(triggerLabel({mode: 'monthly'}), 'Day 1 at 18:00');
        assertEqual(triggerLabel({mode: 'dusk', time: '19:30'}), 'At dusk (19:30)');
        assertEqual(triggerLabel({mode: 'dusk'}), 'At dusk (18:00)');
        assertEqual(triggerLabel({mode: 'interval', intervalValue: 2, intervalUnit: 'hours'}),
            'Every 2 hours');
        assertEqual(triggerLabel({mode: 'interval', intervalValue: 1, intervalUnit: 'days'}),
            'Every 1 day');
        assertEqual(triggerLabel({mode: 'interval', intervalMinutes: 15}),
            'Every 15 minutes');
        assertEqual(triggerLabel({mode: 'realtime'}), 'Real-time');
        assertEqual(triggerLabel({mode: 'manual'}), 'Manual');
        assertEqual(triggerLabel({}), 'Manual');
        assertEqual(triggerLabel(), 'Manual');
    }),
]);
