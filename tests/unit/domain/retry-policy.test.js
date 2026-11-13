import {BACKOFF_MS, RetryPolicy, nextBackoffDelay} from '../../../src/domain/retry-policy.js';
import {assertEqual, suite, test} from '../../harness.js';

export default suite('domain/retry-policy', [
    test('nextBackoffDelay clamps indexes and accepts custom tables', () => {
        assertEqual(nextBackoffDelay(0), BACKOFF_MS[0]);
        assertEqual(nextBackoffDelay(3), BACKOFF_MS[3]);
        assertEqual(nextBackoffDelay(9), BACKOFF_MS[3]);
        assertEqual(nextBackoffDelay(-2), BACKOFF_MS[0]);
        assertEqual(nextBackoffDelay(Number.NaN), BACKOFF_MS[0]);
        assertEqual(nextBackoffDelay(1, [10, 20]), 20);
    }),
    test('RetryPolicy advances, resets and uses custom backoff', () => {
        const policy = new RetryPolicy([100, 200]);
        assertEqual(policy.attempt, 0);
        assertEqual(policy.nextDelay(), 100);
        assertEqual(policy.nextDelay(), 200);
        assertEqual(policy.nextDelay(), 200);
        assertEqual(policy.attempt, 3);
        policy.reset();
        assertEqual(policy.attempt, 0);
        assertEqual(policy.nextDelay(), 100);
        assertEqual(new RetryPolicy().nextDelay(), BACKOFF_MS[0]);
    }),
]);
