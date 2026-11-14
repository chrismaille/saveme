import {DEFAULT_DISK_GUARD, planDiskCheck} from '../../../src/domain/disk-space.js';
import {assertEqual, suite, test} from '../../harness.js';

const MIB = 1024 * 1024;

export default suite('domain/disk-space', [
    test('accepts a destination with the required margin', () => {
        const plan = planDiskCheck({
            sourceBytes: 100 * MIB,
            freeBytes: 200 * MIB,
            safetyPercent: 10,
            minimumFreeBytes: 10 * MIB,
        });
        assertEqual(plan.checked, true);
        assertEqual(plan.ok, true);
        assertEqual(plan.requiredBytes, 120 * MIB);
    }),
    test('rejects a destination that would fill completely', () => {
        const plan = planDiskCheck({
            sourceBytes: 100 * MIB,
            freeBytes: 100 * MIB,
            safetyPercent: 10,
            minimumFreeBytes: 10 * MIB,
        });
        assertEqual(plan.ok, false);
        assertEqual(plan.requiredBytes, 120 * MIB);
    }),
    test('backs up need extra room and skips unknown values', () => {
        assertEqual(planDiskCheck({
            sourceBytes: 100,
            freeBytes: 1000,
            safetyPercent: 0,
            minimumFreeBytes: 0,
            factor: 1.5,
        }).requiredBytes, 150);
        assertEqual(planDiskCheck({sourceBytes: null, freeBytes: 10}).checked, false);
        assertEqual(planDiskCheck({sourceBytes: 10, freeBytes: null}).checked, false);
    }),
    test('normalizes invalid safety values', () => {
        const plan = planDiskCheck({
            sourceBytes: 10,
            freeBytes: 10,
            safetyPercent: -5,
            minimumFreeBytes: -1,
        });
        assertEqual(plan.safetyPercent, 0);
        assertEqual(plan.minimumFreeBytes, 0);
        assertEqual(plan.requiredBytes, 10);
        assertEqual(DEFAULT_DISK_GUARD.safetyPercent, 10);
        assertEqual(DEFAULT_DISK_GUARD.minimumFreeBytes, 512 * MIB);
    }),
    test('treats missing, empty and invalid values as unknown', () => {
        assertEqual(planDiskCheck().checked, false);
        assertEqual(planDiskCheck({sourceBytes: '', freeBytes: 0}).checked, false);
        assertEqual(planDiskCheck({sourceBytes: undefined, freeBytes: 0}).checked, false);
        assertEqual(planDiskCheck({sourceBytes: -1, freeBytes: 0}).checked, false);
        assertEqual(planDiskCheck({sourceBytes: 'x', freeBytes: 0}).checked, false);
        assertEqual(planDiskCheck({sourceBytes: 10, freeBytes: ''}).checked, false);
        assertEqual(planDiskCheck({sourceBytes: 10, freeBytes: null}).checked, false);
        assertEqual(planDiskCheck({sourceBytes: 0, freeBytes: 0}).checked, true);
    }),
    test('accepts custom factors and normalizes invalid factors', () => {
        assertEqual(planDiskCheck({
            sourceBytes: 10,
            freeBytes: 100,
            factor: 2,
            safetyPercent: 0,
            minimumFreeBytes: 0,
        }).requiredBytes, 20);
        assertEqual(planDiskCheck({
            sourceBytes: 10,
            freeBytes: 100,
            factor: 'invalid',
            safetyPercent: 0,
            minimumFreeBytes: 0,
        }).requiredBytes, 10);
    }),
]);
