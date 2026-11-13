import {
    retentionCutoff,
    selectExpiredVersions,
} from '../../../src/domain/retention.js';
import {versionTimestamp} from '../../../src/domain/time.js';
import {assertEqual, suite, test} from '../../harness.js';
import {randomInt, seededRandom} from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;

function nameFor(ms, suffix = '') {
    return `${versionTimestamp(new Date(ms))}${suffix ? `-${suffix}` : ''}`;
}

export default suite('domain/retention', [
    test('retentionCutoff returns null for disabled or invalid retention', () => {
        assertEqual(retentionCutoff(1_000_000, 0), null);
        assertEqual(retentionCutoff(1_000_000, -1), null);
        assertEqual(retentionCutoff(1_000_000, Number.NaN), null);
        assertEqual(retentionCutoff(1_000_000, '0'), null);
        assertEqual(retentionCutoff(1_000_000, undefined), null);
        assertEqual(retentionCutoff(1_000_000, null), null);
        assertEqual(retentionCutoff(1_000_000, Infinity), null);
    }),
    test('retentionCutoff subtracts whole days', () => {
        assertEqual(retentionCutoff(10 * DAY, 3), 7 * DAY);
        assertEqual(retentionCutoff(10 * DAY, '2'), 8 * DAY);
    }),
    test('selectExpiredVersions keeps recent versions and ignores invalid names', () => {
        const now = 20 * DAY;
        const names = [
            nameFor(now - 1 * DAY),
            nameFor(now - 2 * DAY),
            nameFor(now - 10 * DAY, 'run_123456'),
            'not-a-version',
            nameFor(now - 100 * DAY),
        ];
        assertEqual(
            JSON.stringify(selectExpiredVersions(names, {
                nowMs: now,
                retentionDays: 3,
            })),
            JSON.stringify([names[2], names[4]]),
        );
    }),
    test('selectExpiredVersions disables cleanup for zero retention', () => {
        const names = [nameFor(0), nameFor(DAY)];
        assertEqual(selectExpiredVersions(names, {
            nowMs: 100 * DAY,
            retentionDays: 0,
        }).length, 0);
        assertEqual(selectExpiredVersions(names).length, 0);
    }),
    test('selectExpiredVersions treats the cutoff as still valid', () => {
        const now = 20 * DAY;
        const exact = nameFor(now - 3 * DAY);
        const older = nameFor(now - 3 * DAY - 1000);
        assertEqual(JSON.stringify(selectExpiredVersions([exact, older], {
            nowMs: now,
            retentionDays: 3,
        })), JSON.stringify([older]));
    }),
    test('property: expired selection matches the timestamp comparison', () => {
        const random = seededRandom(0x7e7e);
        for (let i = 0; i < 200; i++) {
            const now = randomInt(random, 10 * DAY, 50 * DAY);
            const days = randomInt(random, 1, 20);
            const names = [];
            for (let j = 0; j < 20; j++) {
                const offset = randomInt(random, -30 * DAY, 30 * DAY);
                names.push(nameFor(now + offset, randomInt(random, 0, 1) ? 'run_abcdef' : ''));
            }
            names.push('invalid');
            const expired = selectExpiredVersions(names, {
                nowMs: now,
                retentionDays: days,
            });
            const cutoff = now - days * DAY;
            const expected = names.filter(name => {
                if (name === 'invalid')
                    return false;
                const date = new Date(
                    Number(name.slice(0, 4)),
                    Number(name.slice(4, 6)) - 1,
                    Number(name.slice(6, 8)),
                    Number(name.slice(9, 11)),
                    Number(name.slice(11, 13)),
                    Number(name.slice(13, 15)),
                );
                return date.getTime() < cutoff;
            });
            assertEqual(JSON.stringify(expired), JSON.stringify(expected));
        }
    }),
]);
