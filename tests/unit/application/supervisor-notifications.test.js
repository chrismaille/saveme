import {JobSupervisor} from '../../../src/supervisor.js';
import {assertEqual, suite, test} from '../../harness.js';
import {FakeClock, FakeLogger, FakeState, makeJob} from './fakes.js';

function makeSupervisor(job) {
    const notifications = [];
    const supervisor = new JobSupervisor({
        job,
        runner: {},
        state: new FakeState(),
        logger: new FakeLogger(),
        pool: {},
        getSettings: () => ({}),
        clock: new FakeClock(),
        onNotify: notification => notifications.push(notification),
    });
    return {supervisor, notifications};
}

export default suite('application/supervisor-notifications', [
    test('notifies a completed backup only when the job option is enabled', () => {
        const enabled = makeSupervisor(makeJob('backup', {
            trigger: {mode: 'manual'},
            options: {notifyOnComplete: true},
        }));
        enabled.supervisor._handleRunResult({
            result: 'success',
            kind: 'backup',
            stats: {transfers: 2, bytes: 1024},
        });
        assertEqual(enabled.notifications.length, 1);
        assertEqual(enabled.notifications[0].status, 'success');
        assertEqual(enabled.notifications[0].title, 'SaveMe: backup completed');

        const disabled = makeSupervisor(makeJob('backup', {
            trigger: {mode: 'manual'},
            options: {notifyOnComplete: false},
        }));
        disabled.supervisor._handleRunResult({
            result: 'success',
            kind: 'backup',
            stats: {transfers: 1, bytes: 1},
        });
        assertEqual(disabled.notifications.length, 0);

        const sync = makeSupervisor(makeJob('sync', {
            trigger: {mode: 'manual'},
            options: {notifyOnComplete: true},
        }));
        sync.supervisor._handleRunResult({
            result: 'success',
            kind: 'sync',
            stats: {transfers: 1, bytes: 1},
        });
        assertEqual(sync.notifications.length, 0);
    }),
]);
