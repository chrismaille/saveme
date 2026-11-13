import {
    JobStateMachine,
    cancelledStatus,
    failureStatus,
    idleStatus,
} from '../../../src/domain/job-state-machine.js';
import {JOB_STATUS} from '../../../src/domain/run-state.js';
import {assertEqual, assertThrows, suite, test} from '../../harness.js';

export default suite('domain/job-state-machine', [
    test('idleStatus respects enabled, pause and global pause', () => {
        assertEqual(idleStatus(), JOB_STATUS.IDLE);
        assertEqual(idleStatus({enabled: false}), JOB_STATUS.DISABLED);
        assertEqual(idleStatus({paused: true}), JOB_STATUS.PAUSED);
        assertEqual(idleStatus({pausedAll: true}), JOB_STATUS.PAUSED);
    }),
    test('cancelledStatus respects pause, disabled and source availability', () => {
        assertEqual(cancelledStatus(), JOB_STATUS.PAUSED);
        assertEqual(cancelledStatus({enabled: false}), JOB_STATUS.PAUSED);
        assertEqual(cancelledStatus({paused: true}), JOB_STATUS.PAUSED);
        assertEqual(cancelledStatus({pausedAll: true}), JOB_STATUS.PAUSED);
        assertEqual(cancelledStatus({sourceAvailable: false}), JOB_STATUS.WAITING_SOURCE);
    }),
    test('failureStatus classifies messages', () => {
        assertEqual(failureStatus('Source does not exist'), JOB_STATUS.WAITING_SOURCE);
        assertEqual(failureStatus('Destination is not a directory'), JOB_STATUS.WAITING_DESTINATION);
        assertEqual(failureStatus('auth failed'), JOB_STATUS.NEEDS_AUTH);
        assertEqual(failureStatus('Delete guard'), JOB_STATUS.DELETE_GUARD);
        assertEqual(failureStatus('boom'), JOB_STATUS.ERROR);
    }),
    test('JobStateMachine dispatches events and rejects unknown events', async () => {
        const machine = new JobStateMachine();
        assertEqual(machine.transition('idle', {enabled: false}), JOB_STATUS.DISABLED);
        assertEqual(machine.transition('cancelled', {sourceAvailable: false}),
            JOB_STATUS.WAITING_SOURCE);
        assertEqual(machine.transition('failure', {message: 'boom'}), JOB_STATUS.ERROR);
        assertEqual(machine.shouldRetry(JOB_STATUS.ERROR, 'realtime'), true);
        assertEqual(machine.shouldRetry(JOB_STATUS.ERROR, 'manual'), false);
        await assertThrows(() => machine.transition('unknown'), /Unknown job state event/);
    }),
]);
