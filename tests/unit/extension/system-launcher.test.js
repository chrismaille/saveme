import Gio from 'gi://Gio';
import {SystemLauncher} from '../../../extension/system-launcher.js';
import {assertEqual, suite, test} from '../../harness.js';

function makeLauncher() {
    const calls = [];
    const launcher = new SystemLauncher({
        findProgram(name) {
            calls.push(['find', name]);
            return name === 'saveme-settings' ? '/usr/bin/saveme-settings' : null;
        },
        subprocess: {
            new(argv, flags) {
                calls.push(['spawn', argv, flags]);
                return 'process';
            },
        },
    });
    return {launcher, calls};
}

export default suite('extension/system-launcher', [
    test('find delegates to the lookup function', () => {
        const {launcher, calls} = makeLauncher();
        assertEqual(launcher.find('saveme-settings'), '/usr/bin/saveme-settings');
        assertEqual(launcher.find('missing'), null);
        assertEqual(calls.length, 2);
    }),
    test('spawn passes argv with no special flags', () => {
        const {launcher, calls} = makeLauncher();
        assertEqual(launcher.spawn(['/usr/bin/saveme-settings', '--view', 'logs']),
            'process');
        assertEqual(calls[0][1].join(','), '/usr/bin/saveme-settings,--view,logs');
        assertEqual(calls[0][2], Gio.SubprocessFlags.NONE);
    }),
]);
