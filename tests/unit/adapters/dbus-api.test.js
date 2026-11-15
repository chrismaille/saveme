import {DaemonApi} from '../../../src/adapters/dbus/api.js';
import {assertEqual, suite, test} from '../../harness.js';

function makeApi() {
    const calls = [];
    let quit = false;
    const service = new Proxy({}, {
        get(_target, method) {
            return (...args) => {
                calls.push([method, args]);
                return `${String(method)}-result`;
            };
        },
    });
    const api = new DaemonApi({service, quit: () => {
        quit = true;
    }});
    return {api, calls, quit: () => quit};
}

export default suite('adapters/dbus/api', [
    test('delegates every D-Bus method and converts booleans', () => {
        const {api, calls, quit} = makeApi();
        assertEqual(api.GetSnapshot(), 'snapshotJson-result');
        assertEqual(api.RunJob('job', 1, 0), 'runJob-result');
        assertEqual(api.PlayJob('job'), 'playJob-result');
        api.CancelJob('job');
        api.PauseJob('job', 1);
        api.SetJobEnabled('job', 0);
        api.PauseAll(1);
        assertEqual(api.SaveJob('{}'), 'saveJob-result');
        assertEqual(api.ImportJob('{}'), 'importJob-result');
        assertEqual(api.InspectBackup('/SaveMe'), 'inspectBackup-result');
        api.DeleteJob('job');
        assertEqual(api.GetRun('job', 'run'), 'getRun-result');
        assertEqual(api.GetRunLog('job', 'run'), 'getRunLog-result');
        assertEqual(api.ListRuns('job', 5), 'listRuns-result');
        assertEqual(api.ListVersions('job'), 'listVersions-result');
        assertEqual(api.ListRemote('drive', 'x', 1), 'listRemote-result');
        assertEqual(api.ListBackup('job', 'v', 'x', 0), 'listBackup-result');
        assertEqual(api.Restore('{}'), 'restore-result');
        assertEqual(api.BeginRemoteAuth('drive', 'x', '{}'), 'beginRemoteAuth-result');
        assertEqual(api.GetRemoteAuth('auth'), 'getRemoteAuth-result');
        api.CancelRemoteAuth('auth');
        api.DeleteRemote('drive');
        assertEqual(api.Doctor(), 'doctorJson-result');
        assertEqual(api.GetLogsInfo(), 'logsInfoJson-result');
        assertEqual(api.PruneLogs(), 'pruneLogsJson-result');
        assertEqual(api.ClearLogs('daemon'), 'clearLogsJson-result');
        assertEqual(api.SanitizeLogs(), 'sanitizeLogsJson-result');
        assertEqual(api.UpdateSettings('{}'), 'updateSettingsJson-result');
        api.Quit();
        assertEqual(quit(), true);

        const run = calls.find(call => call[0] === 'runJob');
        assertEqual(JSON.stringify(run[1]), JSON.stringify(['job', true, false]));
        const pause = calls.find(call => call[0] === 'pauseJob');
        assertEqual(JSON.stringify(pause[1]), JSON.stringify(['job', true]));
        assertEqual(JSON.stringify(calls.find(call => call[0] === 'pauseAll')[1]),
            JSON.stringify([true]));
        assertEqual(JSON.stringify(calls.find(call => call[0] === 'listRemote')[1]),
            JSON.stringify(['drive', 'x', true]));
    }),
    test('Quit without a callback is a no-op', () => {
        const service = {snapshotJson: () => '{}'};
        const api = new DaemonApi({service});
        api.Quit();
    }),
]);
