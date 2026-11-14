import {IdleMonitor} from '../../../src/adapters/system/idle-monitor.js';
import {assertEqual, suite, test} from '../../harness.js';

export default suite('adapters/idle-monitor', [
    test('reads the logind IdleHint property', () => {
        const calls = [];
        const bus = {
            call_sync: (...args) => {
                calls.push(args);
                return {deepUnpack: () => [{deepUnpack: () => true}]};
            },
        };
        const monitor = new IdleMonitor({bus, path: '/session/test', timeout: 50});
        assertEqual(monitor.isIdle(), true);
        assertEqual(calls[0][1], '/session/test');
        assertEqual(calls[0][2], 'org.freedesktop.DBus.Properties');
        assertEqual(calls[0][3], 'Get');
        assertEqual(calls[0][7], 50);
    }),
    test('handles plain booleans and unavailable logind', () => {
        const idle = new IdleMonitor({
            bus: {call_sync: () => ({deepUnpack: () => [true]})},
        });
        assertEqual(idle.isIdle(), true);
        const busy = new IdleMonitor({
            bus: {call_sync: () => ({deepUnpack: () => [false]})},
        });
        assertEqual(busy.isIdle(), false);
        const missing = new IdleMonitor({
            bus: {
                call_sync: () => {
                    throw new Error('no logind');
                },
            },
        });
        assertEqual(missing.isIdle(), true);
    }),
]);
