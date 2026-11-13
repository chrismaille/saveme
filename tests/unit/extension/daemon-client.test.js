import {SaveMeDaemonClient} from '../../../extension/daemon-client.js';
import {assertEqual, suite, test} from '../../harness.js';

class FakeBus {
    constructor({reply = null, fail = false} = {}) {
        this.reply = reply;
        this.fail = fail;
        this.subscribes = [];
        this.unsubscribes = [];
        this.calls = [];
        this.nextSignalId = 77;
    }

    signal_subscribe(...args) {
        this.subscribes.push(args);
        return this.nextSignalId++;
    }

    signal_unsubscribe(id) {
        this.unsubscribes.push(id);
    }

    call(_bus, _path, _iface, method, params, _type, _flags, timeout, _cancel, callback) {
        this.calls.push({method, params, timeout});
        const connection = {
            call_finish: () => {
                if (this.fail)
                    throw new Error('daemon unavailable');
                return {deepUnpack: () => [this.reply ?? '{"jobs":[]}']};
            },
        };
        callback(connection, null);
    }
}

function signalFor(bus, index = 0) {
    return bus.subscribes[index][6];
}

export default suite('extension/daemon-client', [
    test('connect subscribes, refreshes and deduplicates snapshots', () => {
        const bus = new FakeBus({reply: '{"jobs":[]}'});
        const snapshots = [];
        const errors = [];
        let after = 0;
        const client = new SaveMeDaemonClient({
            bus,
            onSnapshot: json => snapshots.push(json),
            onError: message => errors.push(message),
            onAfterCall: () => {
                after++;
            },
        });
        client.connect();
        assertEqual(bus.subscribes.length, 1);
        assertEqual(bus.calls[0].method, 'GetSnapshot');
        assertEqual(bus.calls[0].timeout, 5000);
        assertEqual(snapshots.length, 1);
        assertEqual(after, 1);

        signalFor(bus)(null, null, null, null, null, {
            deepUnpack: () => ['{"jobs":[]}'],
        });
        assertEqual(snapshots.length, 1);

        signalFor(bus)(null, null, null, null, null, {
            deepUnpack: () => ['{"jobs":[{"id":"job"}]}'],
        });
        assertEqual(snapshots.length, 2);

        signalFor(bus)(null, null, null, null, null, {
            deepUnpack: () => {
                throw new Error('bad signal');
            },
        });
        assertEqual(errors[0], 'bad signal');

        client.disconnect();
        assertEqual(bus.unsubscribes[0], 77);
        client.disconnect();
        assertEqual(bus.unsubscribes.length, 1);
        client.connect();
        assertEqual(snapshots.length, 3);
    }),
    test('job commands send the expected variants', () => {
        const bus = new FakeBus({reply: 'run_1'});
        let after = 0;
        const client = new SaveMeDaemonClient({
            bus,
            onAfterCall: () => {
                after++;
            },
        });
        client.runJob('job_1');
        client.cancelJob('job_1');
        client.pauseJob('job_1', true);
        client.pauseAll(false);
        assertEqual(bus.calls.length, 4);
        assertEqual(JSON.stringify(bus.calls[0].params.deepUnpack()),
            JSON.stringify(['job_1', false, false]));
        assertEqual(JSON.stringify(bus.calls[1].params.deepUnpack()),
            JSON.stringify(['job_1']));
        assertEqual(JSON.stringify(bus.calls[2].params.deepUnpack()),
            JSON.stringify(['job_1', true]));
        assertEqual(JSON.stringify(bus.calls[3].params.deepUnpack()),
            JSON.stringify([false]));
        assertEqual(after, 4);
    }),
    test('call failures report errors without refreshing', () => {
        const bus = new FakeBus({fail: true});
        const errors = [];
        let after = 0;
        const client = new SaveMeDaemonClient({
            bus,
            onError: message => errors.push(message),
            onAfterCall: () => {
                after++;
            },
        });
        client.refresh();
        client.runJob('job_1');
        assertEqual(errors.length, 2);
        assertEqual(errors[0], 'daemon unavailable');
        assertEqual(after, 0);
    }),
    test('snapshot cache can be invalidated after an error', () => {
        const bus = new FakeBus({reply: '{"jobs":[]}'});
        const snapshots = [];
        const client = new SaveMeDaemonClient({
            bus,
            onSnapshot: json => snapshots.push(json),
        });
        client.refresh();
        client.refresh();
        assertEqual(snapshots.length, 1);
        client.invalidateSnapshot();
        client.refresh();
        assertEqual(snapshots.length, 2);
    }),
    test('disconnect tolerates an unsubscribe failure and empty state', () => {
        const bus = new FakeBus();
        bus.signal_unsubscribe = () => {
            throw new Error('bus gone');
        };
        const client = new SaveMeDaemonClient({bus});
        client.disconnect();
        client.connect();
        client.disconnect();
        assertEqual(bus.subscribes.length, 1);
    }),
]);
