import {ExtensionManager} from '../../../app/extension-manager.js';
import {assertEqual, suite, test} from '../../harness.js';

function makeManager({
    available = true,
    system = false,
    zip = true,
    user = false,
    zipMtime = 20,
    userMtime = 10,
    failInstall = false,
    failEnable = false,
} = {}) {
    const calls = [];
    const launcher = {
        find(name) {
            calls.push(['find', name]);
            return available ? `/usr/bin/${name}` : null;
        },
        async capture(argv) {
            calls.push(['capture', ...argv]);
            if (failInstall && argv[1] === 'install')
                throw new Error('install failed');
            if (failEnable && argv[1] === 'enable')
                throw new Error('enable failed');
            return '';
        },
    };
    const manager = new ExtensionManager({
        launcher,
        uuid: 'saveme@test',
        zipPath: '/zip',
        systemDir: '/system',
        userDir: '/user',
        fileExists: path => ({
            '/system': system,
            '/zip': zip,
            '/user': user,
        })[path] || false,
        fileModified: path => path === '/zip' ? zipMtime : userMtime,
    });
    return {manager, calls};
}

export default suite('app/extension-manager', [
    test('skips when gnome-extensions is unavailable', async () => {
        const {manager, calls} = makeManager({available: false});
        assertEqual(await manager.ensure(), 'unavailable');
        assertEqual(calls[0][0], 'find');
        assertEqual(calls.length, 1);
    }),
    test('enables a system-wide extension without installing', async () => {
        const {manager, calls} = makeManager({system: true});
        assertEqual(await manager.ensure(), 'system');
        assertEqual(calls.at(-1).join(' '), 'capture gnome-extensions enable saveme@test');
        assertEqual(calls.some(call => call[2] === 'install'), false);
    }),
    test('skips when the package zip is missing', async () => {
        const {manager, calls} = makeManager({zip: false});
        assertEqual(await manager.ensure(), 'missing');
        assertEqual(calls.some(call => call[0] === 'capture'), false);
    }),
    test('installs a missing extension and enables it', async () => {
        const {manager, calls} = makeManager();
        assertEqual(await manager.ensure(), 'user');
        assertEqual(calls.some(call => call[2] === 'install'), true);
        assertEqual(calls.at(-1).join(' '), 'capture gnome-extensions enable saveme@test');
    }),
    test('refreshes a user extension when the package zip is newer', async () => {
        const {manager, calls} = makeManager({
            user: true, zipMtime: 30, userMtime: 10,
        });
        assertEqual(await manager.ensure(), 'user');
        assertEqual(calls.filter(call => call[2] === 'install').length, 1);
    }),
    test('does not reinstall an up-to-date user extension', async () => {
        const {manager, calls} = makeManager({
            user: true, zipMtime: 10, userMtime: 20,
        });
        assertEqual(await manager.ensure(), 'user');
        assertEqual(calls.some(call => call[2] === 'install'), false);
    }),
    test('reports install and enable failures without throwing', async () => {
        const failedInstall = makeManager({failInstall: true});
        assertEqual(await failedInstall.manager.ensure(), 'failed');

        const failedEnable = makeManager({failEnable: true});
        assertEqual(await failedEnable.manager.ensure(), 'user');
    }),
]);
