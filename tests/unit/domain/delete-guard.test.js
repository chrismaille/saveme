import {DeleteGuardError} from '../../../src/domain/errors.js';
import {
    assertDeleteAllowed,
    deleteLimit,
    evaluateDeleteGuard,
} from '../../../src/domain/delete-guard.js';
import {assert, assertEqual, assertThrows, suite, test} from '../../harness.js';
import {randomInt, seededRandom} from './helpers.js';

export default suite('domain/delete-guard', [
    test('deleteLimit uses the absolute minimum and the percentage', () => {
        assertEqual(deleteLimit(100, {maxDeletePercent: 10, maxDeleteMinimum: 10}), 10);
        assertEqual(deleteLimit(100, {maxDeletePercent: 50, maxDeleteMinimum: 0}), 50);
        assertEqual(deleteLimit(5, {maxDeletePercent: 10, maxDeleteMinimum: 10}), 5);
        assertEqual(deleteLimit(0, {maxDeletePercent: 10, maxDeleteMinimum: 10}), 0);
        assertEqual(deleteLimit(100, {maxDeletePercent: 0, maxDeleteMinimum: 10}), 10);
    }),
    test('deleteLimit handles invalid numbers and invalid totals', () => {
        assertEqual(deleteLimit(Number.NaN), null);
        assertEqual(deleteLimit(Infinity), null);
        assertEqual(deleteLimit(10), 10);
        assertEqual(deleteLimit(100, {
            maxDeletePercent: Number.NaN,
            maxDeleteMinimum: Number.NaN,
        }), 10);
    }),
    test('evaluateDeleteGuard blocks only above the limit and only without force', () => {
        const allowed = evaluateDeleteGuard({
            deletes: 10,
            total: 100,
            maxDeletePercent: 10,
            maxDeleteMinimum: 10,
        });
        assertEqual(allowed.allowed, 10);
        assertEqual(allowed.blocked, false);

        const blocked = evaluateDeleteGuard({
            deletes: 11,
            total: 100,
            maxDeletePercent: 10,
            maxDeleteMinimum: 10,
        });
        assertEqual(blocked.blocked, true);

        const forced = evaluateDeleteGuard({
            deletes: 11,
            total: 100,
            maxDeletePercent: 10,
            maxDeleteMinimum: 10,
            force: true,
        });
        assertEqual(forced.blocked, false);
    }),
    test('evaluateDeleteGuard handles unknown totals and invalid percentages', () => {
        const defaults = evaluateDeleteGuard();
        assertEqual(defaults.deletes, 0);
        assertEqual(defaults.total, 0);
        assertEqual(defaults.allowed, 0);
        assertEqual(defaults.blocked, false);

        const partial = evaluateDeleteGuard({total: 10});
        assertEqual(partial.allowed, 10);
        assertEqual(partial.blocked, false);

        const unknown = evaluateDeleteGuard({deletes: 0, total: Number.NaN});
        assertEqual(unknown.allowed, null);
        assertEqual(unknown.blocked, false);
        assertEqual(unknown.percent, 10);

        const invalid = evaluateDeleteGuard({
            deletes: 1,
            total: 10,
            maxDeletePercent: Number.NaN,
            maxDeleteMinimum: 0,
        });
        assertEqual(invalid.allowed, 1);
        assertEqual(invalid.percent, 10);
    }),
    test('assertDeleteAllowed throws DeleteGuardError when blocked', async () => {
        const error = await assertThrows(() => assertDeleteAllowed({
            deletes: 5,
            total: 10,
            maxDeletePercent: 10,
            maxDeleteMinimum: 0,
        }), /Delete guard/);
        assert(error instanceof DeleteGuardError);
        assertEqual(error.deletes, 5);
        assertEqual(error.allowed, 1);
        assertEqual(error.total, 10);
        assertEqual(error.percent, 10);

        const result = assertDeleteAllowed({
            deletes: 5,
            total: 10,
            maxDeletePercent: 10,
            maxDeleteMinimum: 0,
            force: true,
        });
        assertEqual(result.blocked, false);
    }),
    test('property: limit stays in bounds and the guard matches the limit', () => {
        const random = seededRandom(0xdec0de);
        for (let i = 0; i < 500; i++) {
            const total = randomInt(random, 0, 5000);
            const percent = randomInt(random, 0, 100);
            const minimum = randomInt(random, 0, 200);
            const allowed = deleteLimit(total, {
                maxDeletePercent: percent,
                maxDeleteMinimum: minimum,
            });
            assert(allowed >= 0 && allowed <= total, `allowed=${allowed} total=${total}`);
            assertEqual(allowed, Math.min(total,
                Math.max(minimum, Math.floor(total * percent / 100))));

            const deletes = randomInt(random, 0, total + 100);
            const guard = evaluateDeleteGuard({
                deletes,
                total,
                maxDeletePercent: percent,
                maxDeleteMinimum: minimum,
            });
            assertEqual(guard.blocked, deletes > allowed);
            assertEqual(guard.deletes, deletes);
            assertEqual(guard.total, total);
            assertEqual(guard.percent, percent);
        }
    }),
]);
