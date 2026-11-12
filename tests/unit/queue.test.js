import {ChangeQueue} from '../../src/queue.js';
import {sleep} from '../../src/util.js';
import {assertEqual, suite, test} from '../harness.js';

async function collect(operations, {debounceMs = 20, maxBatchMs = 50} = {}) {
    const batches = [];
    const queue = new ChangeQueue({
        debounceMs,
        maxBatchMs,
        onFlush: changes => batches.push(changes),
    });
    for (const [path, kind] of operations)
        queue.add(path, kind);
    await sleep(120);
    queue.stop();
    return batches;
}

export default suite('queue', [
    test('coalesces upsert followed by delete', async () => {
        const batches = await collect([
            ['/a/file', 'upsert'],
            ['/a/file', 'delete'],
        ]);
        assertEqual(batches.length, 1);
        assertEqual(batches[0].length, 1);
        assertEqual(batches[0][0].kind, 'delete');
    }),
    test('coalesces delete followed by upsert', async () => {
        const batches = await collect([
            ['/a/file', 'delete'],
            ['/a/file', 'upsert'],
        ]);
        assertEqual(batches[0][0].kind, 'upsert');
    }),
    test('dir-delete plus child upsert becomes dir-upsert', async () => {
        const batches = await collect([
            ['/a/dir', 'dir-delete'],
            ['/a/dir/file', 'upsert'],
        ]);
        assertEqual(batches[0].length, 1);
        assertEqual(batches[0][0].kind, 'dir-upsert');
    }),
    test('dir-upsert keeps later child events', async () => {
        const batches = await collect([
            ['/a/dir', 'dir-upsert'],
            ['/a/dir/file', 'upsert'],
        ]);
        assertEqual(batches[0].length, 2);
    }),
    test('dir-upsert removes earlier child events', async () => {
        const batches = await collect([
            ['/a/dir/file', 'upsert'],
            ['/a/dir', 'dir-upsert'],
        ]);
        assertEqual(batches[0].length, 1);
        assertEqual(batches[0][0].kind, 'dir-upsert');
    }),
]);
