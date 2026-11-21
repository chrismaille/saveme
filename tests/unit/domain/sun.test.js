import {sunsetTime} from '../../../src/domain/sun.js';
import {assertEqual, suite, test} from '../../harness.js';

export default suite('domain/sun', [
    test('computes local sunset for a coordinate and date', () => {
        assertEqual(sunsetTime(-23.5505, -46.6333,
            new Date(2026, 10, 21, 12, 0, 0), 180), '18:34');
        assertEqual(sunsetTime(51.5074, -0.1278,
            new Date(2026, 5, 21, 12, 0, 0), 0), '20:21');
        assertEqual(sunsetTime(0, 0,
            new Date(2026, 5, 21, 12, 0, 0), 0), '18:05');
    }),
    test('returns null for invalid coordinates and polar days', () => {
        assertEqual(sunsetTime(NaN, 0), null);
        assertEqual(sunsetTime(0, Infinity), null);
        assertEqual(sunsetTime(0, 0, new Date(), NaN), null);
        assertEqual(sunsetTime(999, 0), null);
        assertEqual(sunsetTime(0, 999), null);
        assertEqual(sunsetTime(90, 0, new Date(2026, 5, 21, 12), 0), null);
        assertEqual(sunsetTime(80, 0, new Date(2026, 5, 21, 12), 0), null);
        assertEqual(sunsetTime(80, 0, new Date(2026, 11, 21, 12), 0), null);
    }),
]);
