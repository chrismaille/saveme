import {
    BACKOFF_MS,
    JOB_STATUS,
    isCancelledRun,
    isSuccessfulRun,
    nextBackoffDelay,
    shouldRetryAfterRun,
    statusFromError,
} from '../../../src/domain/run-state.js';
import {TRIGGER_MODES} from '../../../src/domain/job.js';
import {assertEqual, suite, test} from '../../harness.js';

export default suite('domain/run-state', [
    test('exposes stable status and backoff constants', () => {
        assertEqual(JOB_STATUS.IDLE, 'idle');
        assertEqual(JOB_STATUS.DELETE_GUARD, 'delete-guard');
        assertEqual(BACKOFF_MS.length, 4);
        assertEqual(BACKOFF_MS[0], 60_000);
    }),
    test('statusFromError classifies source and destination failures', () => {
        assertEqual(statusFromError('Source does not exist: /x'), JOB_STATUS.WAITING_SOURCE);
        assertEqual(statusFromError('source volume unavailable'), JOB_STATUS.WAITING_SOURCE);
        assertEqual(statusFromError('Source is not a directory'), JOB_STATUS.WAITING_SOURCE);
        assertEqual(statusFromError('Destination is not a directory'), JOB_STATUS.WAITING_DESTINATION);
        assertEqual(statusFromError('destination volume unavailable'), JOB_STATUS.WAITING_DESTINATION);
    }),
    test('statusFromError classifies auth, delete guard and generic errors', () => {
        assertEqual(statusFromError('auth required'), JOB_STATUS.NEEDS_AUTH);
        assertEqual(statusFromError('token expired'), JOB_STATUS.NEEDS_AUTH);
        assertEqual(statusFromError('unauthorized'), JOB_STATUS.NEEDS_AUTH);
        assertEqual(statusFromError('forbidden'), JOB_STATUS.NEEDS_AUTH);
        assertEqual(statusFromError('HTTP 401'), JOB_STATUS.NEEDS_AUTH);
        assertEqual(statusFromError('HTTP 403'), JOB_STATUS.NEEDS_AUTH);
        assertEqual(statusFromError('reauth needed'), JOB_STATUS.NEEDS_AUTH);
        assertEqual(statusFromError('Delete guard: 5 > 2'), JOB_STATUS.DELETE_GUARD);
        assertEqual(statusFromError('boom'), JOB_STATUS.ERROR);
    }),
    test('nextBackoffDelay clamps indexes and supports custom tables', () => {
        assertEqual(nextBackoffDelay(0), BACKOFF_MS[0]);
        assertEqual(nextBackoffDelay(1), BACKOFF_MS[1]);
        assertEqual(nextBackoffDelay(2), BACKOFF_MS[2]);
        assertEqual(nextBackoffDelay(3), BACKOFF_MS[3]);
        assertEqual(nextBackoffDelay(4), BACKOFF_MS[3]);
        assertEqual(nextBackoffDelay(-1), BACKOFF_MS[0]);
        assertEqual(nextBackoffDelay(Number.NaN), BACKOFF_MS[0]);
        assertEqual(nextBackoffDelay(1, [10, 20]), 20);
        assertEqual(nextBackoffDelay(5, [10, 20]), 20);
    }),
    test('run result helpers distinguish success, noop, cancelled and errors', () => {
        assertEqual(isSuccessfulRun('success'), true);
        assertEqual(isSuccessfulRun('noop'), true);
        assertEqual(isSuccessfulRun('error'), false);
        assertEqual(isSuccessfulRun('cancelled'), false);
        assertEqual(isCancelledRun('cancelled'), true);
        assertEqual(isCancelledRun('success'), false);
    }),
    test('shouldRetryAfterRun retries waiting states and non-manual errors', () => {
        assertEqual(shouldRetryAfterRun(JOB_STATUS.WAITING_SOURCE, TRIGGER_MODES.MANUAL), true);
        assertEqual(shouldRetryAfterRun(JOB_STATUS.WAITING_DESTINATION, TRIGGER_MODES.REALTIME), true);
        assertEqual(shouldRetryAfterRun(JOB_STATUS.NEEDS_AUTH, TRIGGER_MODES.REALTIME), false);
        assertEqual(shouldRetryAfterRun(JOB_STATUS.DELETE_GUARD, TRIGGER_MODES.REALTIME), false);
        assertEqual(shouldRetryAfterRun(JOB_STATUS.ERROR, TRIGGER_MODES.REALTIME), true);
        assertEqual(shouldRetryAfterRun(JOB_STATUS.ERROR, TRIGGER_MODES.INTERVAL), true);
        assertEqual(shouldRetryAfterRun(JOB_STATUS.ERROR, TRIGGER_MODES.MANUAL), false);
    }),
]);
