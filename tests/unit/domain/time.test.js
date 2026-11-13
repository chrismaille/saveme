import {parseVersionTimestamp, versionTimestamp} from '../../../src/domain/time.js';
import {assert, assertEqual, suite, test} from '../../harness.js';
import {randomInt, randomString, seededRandom} from './helpers.js';

export default suite('domain/time', [
    test('versionTimestamp pads every component', () => {
        assertEqual(versionTimestamp(new Date(2026, 0, 2, 3, 4, 5)), '20260102T030405');
        assertEqual(versionTimestamp(new Date(2026, 11, 31, 23, 59, 59)), '20261231T235959');
        assert(/^\d{8}T\d{6}$/.test(versionTimestamp()), 'default date should be formatted');
    }),
    test('parseVersionTimestamp accepts dates with and without suffix/trailing slash', () => {
        const date = parseVersionTimestamp('20260102T030405');
        assertEqual(date.getFullYear(), 2026);
        assertEqual(date.getMonth(), 0);
        assertEqual(date.getDate(), 2);
        assertEqual(date.getHours(), 3);
        assertEqual(date.getMinutes(), 4);
        assertEqual(date.getSeconds(), 5);

        const suffixed = parseVersionTimestamp('20260102T030405-run_abc/');
        assertEqual(suffixed.getTime(), date.getTime());
    }),
    test('parseVersionTimestamp rejects malformed names and invalid dates', () => {
        assertEqual(parseVersionTimestamp(''), null);
        assertEqual(parseVersionTimestamp('not-a-date'), null);
        assertEqual(parseVersionTimestamp('20260102'), null);
        assertEqual(parseVersionTimestamp('999999999999999999999999T000000'), null);
    }),
    test('version timestamps round-trip and are sortable', () => {
        const dates = [
            new Date(2025, 0, 1, 0, 0, 0),
            new Date(2026, 5, 15, 12, 30, 45),
            new Date(2026, 11, 31, 23, 59, 59),
        ];
        const names = dates.map(date => versionTimestamp(date));
        assertEqual(JSON.stringify([...names].sort()), JSON.stringify(names));
        for (let i = 0; i < dates.length; i++)
            assertEqual(parseVersionTimestamp(names[i]).getTime(), dates[i].getTime());
    }),
    test('property: generated timestamps parse back to the same second', () => {
        const random = seededRandom(0x7711);
        for (let i = 0; i < 200; i++) {
            const date = new Date(
                2000 + randomInt(random, 0, 50),
                randomInt(random, 0, 11),
                randomInt(random, 1, 28),
                randomInt(random, 0, 23),
                randomInt(random, 0, 59),
                randomInt(random, 0, 59),
            );
            const name = versionTimestamp(date);
            const parsed = parseVersionTimestamp(name);
            assert(parsed !== null, `could not parse ${name}`);
            assertEqual(parsed.getTime(), date.getTime(), name);
            const suffixed = `${name}-${randomString(random, 'abc123', 4, 8)}`;
            assertEqual(parseVersionTimestamp(suffixed).getTime(), date.getTime(), suffixed);
        }
    }),
]);
