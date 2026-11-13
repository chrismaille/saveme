import {RunCoordinator} from '../../../src/application/run-coordinator.js';
import {assertEqual, suite, test} from '../../harness.js';

function fakeService() {
    return {
        calls: [],
        async runFull(job, options) {
            this.calls.push({method: 'full', job, options});
            return {service: this, method: 'full'};
        },
        async runIncremental(job, changes, options) {
            this.calls.push({method: 'incremental', job, changes, options});
            return {service: this, method: 'incremental'};
        },
    };
}

export default suite('application/run-coordinator', [
    test('dispatches full runs to sync and backup services', async () => {
        const sync = fakeService();
        const backup = fakeService();
        const coordinator = new RunCoordinator({sync, backup});
        const syncResult = await coordinator.runFull({type: 'sync'});
        const backupResult = await coordinator.runFull({type: 'backup'});
        assertEqual(syncResult.service, sync);
        assertEqual(backupResult.service, backup);
        assertEqual(sync.calls[0].method, 'full');
        assertEqual(backup.calls[0].method, 'full');
    }),
    test('dispatches incremental runs to sync and backup services', async () => {
        const sync = fakeService();
        const backup = fakeService();
        const coordinator = new RunCoordinator({sync, backup});
        const changes = [{path: '/a', kind: 'upsert'}];
        const syncResult = await coordinator.runIncremental({type: 'sync'}, changes);
        const backupResult = await coordinator.runIncremental({type: 'backup'}, changes);
        assertEqual(syncResult.service, sync);
        assertEqual(backupResult.service, backup);
        assertEqual(sync.calls[0].method, 'incremental');
        assertEqual(backup.calls[0].method, 'incremental');
    }),
]);
