import Gio from 'gi://Gio';
import {SystemLauncher} from '../../../app/gateway/system-launcher.js';
import {assertEqual, suite, test} from '../../harness.js';

function makeLauncher() {
    const calls = [];
    const launcher = new SystemLauncher({
        subprocess: {
            new(argv, flags) {
                calls.push(['spawn', argv, flags]);
                return 'process';
            },
        },
        appInfo: {
            launch_default_for_uri(uri, context) {
                calls.push(['open', uri, context]);
                return true;
            },
        },
        file: {
            new_for_path(path) {
                return {get_uri: () => `file://${path}`};
            },
        },
        findProgram(name) {
            calls.push(['find', name]);
            return name === 'saveme-daemon' ? '/usr/bin/saveme-daemon' : null;
        },
    });
    return {launcher, calls};
}

export default suite('app/gateway/system-launcher', [
    test('find delegates to the lookup function', () => {
        const {launcher, calls} = makeLauncher();
        assertEqual(launcher.find('saveme-daemon'), '/usr/bin/saveme-daemon');
        assertEqual(launcher.find('missing'), null);
        assertEqual(calls.length, 2);
    }),
    test('spawn passes argv and silence flags', () => {
        const {launcher, calls} = makeLauncher();
        assertEqual(launcher.spawn(['/bin/true']), 'process');
        assertEqual(launcher.spawn(['/bin/false'], {silent: true}), 'process');
        assertEqual(calls[0][1].join(','), '/bin/true');
        assertEqual(calls[0][2], Gio.SubprocessFlags.NONE);
        assertEqual(calls[1][2],
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
    }),
    test('openPath converts the path to a file URI', () => {
        const {launcher, calls} = makeLauncher();
        assertEqual(launcher.openPath('/tmp/my file'), true);
        assertEqual(calls[0][1], 'file:///tmp/my file');
        assertEqual(calls[0][2], null);
    }),
]);
