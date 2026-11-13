import {DaemonGateway} from '../../../app/gateway/daemon-gateway.js';
import {assertEqual, suite, test} from '../../harness.js';

function fakeClient() {
    const calls = [];
    const record = name => (...args) => {
        calls.push([name, args]);
        if (name === 'onSnapshot' || name === 'onRemoteAuth')
            return () => calls.push([`${name}-unsubscribe`]);
        return `${name}-result`;
    };
    const names = [
        'close',
        'onSnapshot',
        'onRemoteAuth',
        'getSnapshot',
        'runJob',
        'cancelJob',
        'pauseJob',
        'setJobEnabled',
        'pauseAll',
        'saveJob',
        'deleteJob',
        'getRun',
        'getRunLog',
        'listRuns',
        'listVersions',
        'listRemote',
        'listBackup',
        'restore',
        'beginRemoteAuth',
        'getRemoteAuth',
        'cancelRemoteAuth',
        'deleteRemote',
        'doctor',
        'getLogsInfo',
        'pruneLogs',
        'clearLogs',
        'sanitizeLogs',
        'updateSettings',
    ];
    const client = {calls};
    for (const name of names)
        client[name] = record(name);
    return client;
}

const byName = (client, name) => client.calls.filter(call => call[0] === name);

export default suite('app/gateway/daemon-gateway', [
    test('subscriptions and close delegate to the client', () => {
        const client = fakeClient();
        const gateway = new DaemonGateway({client});
        const offSnapshot = gateway.onSnapshot(() => {});
        const offAuth = gateway.onRemoteAuth(() => {});
        offSnapshot();
        offAuth();
        gateway.close();
        assertEqual(byName(client, 'onSnapshot').length, 1);
        assertEqual(byName(client, 'onRemoteAuth').length, 1);
        assertEqual(byName(client, 'onSnapshot-unsubscribe').length, 1);
        assertEqual(byName(client, 'onRemoteAuth-unsubscribe').length, 1);
        assertEqual(byName(client, 'close').length, 1);
    }),
    test('job and daemon calls preserve defaults', async () => {
        const client = fakeClient();
        const gateway = new DaemonGateway({client});
        assertEqual(await gateway.getSnapshot(), 'getSnapshot-result');
        assertEqual(await gateway.runJob('job'), 'runJob-result');
        assertEqual(await gateway.runJob('job', true, true), 'runJob-result');
        assertEqual(await gateway.cancelJob('job'), 'cancelJob-result');
        assertEqual(await gateway.pauseJob('job', true), 'pauseJob-result');
        assertEqual(await gateway.setJobEnabled('job', false), 'setJobEnabled-result');
        assertEqual(await gateway.pauseAll(true), 'pauseAll-result');
        assertEqual(await gateway.deleteJob('job'), 'deleteJob-result');
        assertEqual(byName(client, 'runJob')[0][1].join(','), 'job,false,false');
        assertEqual(byName(client, 'runJob')[1][1].join(','), 'job,true,true');
    }),
    test('history, browser and restore calls forward arguments', async () => {
        const client = fakeClient();
        const gateway = new DaemonGateway({client});
        assertEqual(await gateway.getRun('job', 'run'), 'getRun-result');
        assertEqual(await gateway.getRunLog('job', 'run'), 'getRunLog-result');
        assertEqual(await gateway.listRuns('job'), 'listRuns-result');
        assertEqual(await gateway.listRuns('job', 10), 'listRuns-result');
        assertEqual(await gateway.getRun('job', 'run'), 'getRun-result');
        assertEqual(await gateway.listVersions('job'), 'listVersions-result');
        assertEqual(await gateway.listRemote('drive'), 'listRemote-result');
        assertEqual(await gateway.listRemote('drive', 'x', true), 'listRemote-result');
        assertEqual(await gateway.listBackup('job'), 'listBackup-result');
        assertEqual(await gateway.listBackup('job', 'v', 'x', true), 'listBackup-result');
        assertEqual(await gateway.restore({jobId: 'job'}), 'restore-result');
        assertEqual(JSON.stringify(byName(client, 'listRuns')[0][1]), JSON.stringify(['job', 50]));
        assertEqual(JSON.stringify(byName(client, 'listRemote')[0][1]),
            JSON.stringify(['drive', '', false]));
        assertEqual(JSON.stringify(byName(client, 'listBackup')[0][1]),
            JSON.stringify(['job', '', '', false]));
    }),
    test('job editing, auth and diagnostics delegate', async () => {
        const client = fakeClient();
        const gateway = new DaemonGateway({client});
        const job = {id: 'job', name: 'Daily'};
        assertEqual(await gateway.saveJob(job), 'saveJob-result');
        assertEqual(await gateway.beginRemoteAuth('drive', 'me'), 'beginRemoteAuth-result');
        assertEqual(await gateway.beginRemoteAuth('drive', 'me', {scope: 'x'}),
            'beginRemoteAuth-result');
        assertEqual(await gateway.getRemoteAuth('auth'), 'getRemoteAuth-result');
        assertEqual(await gateway.cancelRemoteAuth('auth'), 'cancelRemoteAuth-result');
        assertEqual(await gateway.deleteRemote('drive'), 'deleteRemote-result');
        assertEqual(await gateway.doctor(), 'doctor-result');
        assertEqual(byName(client, 'saveJob')[0][1][0], job);
        assertEqual(JSON.stringify(byName(client, 'beginRemoteAuth')[0][1]),
            JSON.stringify(['drive', 'me', {}]));
        assertEqual(JSON.stringify(byName(client, 'beginRemoteAuth')[1][1]),
            JSON.stringify(['drive', 'me', {scope: 'x'}]));
    }),
    test('log management and settings delegate', async () => {
        const client = fakeClient();
        const gateway = new DaemonGateway({client});
        assertEqual(await gateway.getLogsInfo(), 'getLogsInfo-result');
        assertEqual(await gateway.pruneLogs(), 'pruneLogs-result');
        assertEqual(await gateway.clearLogs('daemon'), 'clearLogs-result');
        assertEqual(await gateway.sanitizeLogs(), 'sanitizeLogs-result');
        assertEqual(await gateway.updateSettings({logRetentionDays: 7}),
            'updateSettings-result');
        assertEqual(byName(client, 'clearLogs')[0][1][0], 'daemon');
        assertEqual(byName(client, 'updateSettings')[0][1][0].logRetentionDays, 7);
    }),
]);
