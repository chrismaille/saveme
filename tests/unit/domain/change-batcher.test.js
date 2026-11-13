import {ChangeBatcher, coalesceChange} from '../../../src/domain/change-batcher.js';
import {assertEqual, suite, test} from '../../harness.js';
import {pick, randomInt, randomString, seededRandom} from './helpers.js';

function batch(operations) {
    const batcher = new ChangeBatcher();
    for (const [path, kind] of operations)
        batcher.add(path, kind);
    return batcher.drain();
}

function shape(changes) {
    return changes.map(change => `${change.path}:${change.kind}`);
}

export default suite('domain/change-batcher', [
    test('coalesceChange covers every state pair', () => {
        assertEqual(coalesceChange('upsert', 'upsert'), 'upsert');
        assertEqual(coalesceChange('upsert', 'delete'), 'delete');
        assertEqual(coalesceChange('delete', 'upsert'), 'upsert');
        assertEqual(coalesceChange('dir-upsert', 'dir-delete'), 'dir-delete');
        assertEqual(coalesceChange('dir-delete', 'dir-upsert'), 'dir-upsert');
        assertEqual(coalesceChange('dir-upsert', 'delete'), 'dir-upsert');
        assertEqual(coalesceChange('delete', 'dir-upsert'), 'dir-upsert');
        assertEqual(coalesceChange('delete', 'rename'), 'rename');
    }),
    test('ignores empty paths and kinds', () => {
        const batcher = new ChangeBatcher();
        assertEqual(batcher.add('', 'upsert'), false);
        assertEqual(batcher.add('/a', ''), false);
        assertEqual(batcher.size, 0);
    }),
    test('coalesces regular upserts and deletes', () => {
        assertEqual(JSON.stringify(shape(batch([
            ['/a', 'upsert'],
            ['/a', 'delete'],
        ]))), JSON.stringify(['/a:delete']));
        assertEqual(JSON.stringify(shape(batch([
            ['/a', 'delete'],
            ['/a', 'upsert'],
        ]))), JSON.stringify(['/a:upsert']));
    }),
    test('coalesces directory events', () => {
        assertEqual(JSON.stringify(shape(batch([
            ['/a', 'dir-upsert'],
            ['/a', 'dir-delete'],
        ]))), JSON.stringify(['/a:dir-delete']));
        assertEqual(JSON.stringify(shape(batch([
            ['/a', 'dir-delete'],
            ['/a', 'dir-upsert'],
        ]))), JSON.stringify(['/a:dir-upsert']));
        assertEqual(JSON.stringify(shape(batch([
            ['/a', 'dir-upsert'],
            ['/a', 'upsert'],
        ]))), JSON.stringify(['/a:dir-upsert']));
        assertEqual(JSON.stringify(shape(batch([
            ['/a', 'upsert'],
            ['/a', 'dir-upsert'],
        ]))), JSON.stringify(['/a:dir-upsert']));
    }),
    test('dir-delete followed by a child event becomes dir-upsert', () => {
        assertEqual(JSON.stringify(shape(batch([
            ['/a', 'dir-delete'],
            ['/a/file', 'upsert'],
        ]))), JSON.stringify(['/a:dir-upsert']));
    }),
    test('dir-delete followed by a child delete is a no-op', () => {
        const batcher = new ChangeBatcher();
        batcher.add('/a', 'dir-delete');
        assertEqual(batcher.add('/a/file', 'delete'), false);
        assertEqual(JSON.stringify(shape(batcher.drain())), JSON.stringify(['/a:dir-delete']));
    }),
    test('dir-upsert keeps later child events', () => {
        assertEqual(JSON.stringify(shape(batch([
            ['/a', 'dir-upsert'],
            ['/a/file', 'upsert'],
        ]))), JSON.stringify(['/a:dir-upsert', '/a/file:upsert']));
    }),
    test('directory events remove earlier children', () => {
        assertEqual(JSON.stringify(shape(batch([
            ['/a/file', 'upsert'],
            ['/a/other', 'delete'],
            ['/a', 'dir-upsert'],
        ]))), JSON.stringify(['/a:dir-upsert']));
        assertEqual(JSON.stringify(shape(batch([
            ['/a/file', 'upsert'],
            ['/a', 'dir-delete'],
        ]))), JSON.stringify(['/a:dir-delete']));
    }),
    test('drain clears the batch and size tracks entries', () => {
        const batcher = new ChangeBatcher();
        batcher.add('/a', 'upsert');
        batcher.add('/b', 'delete');
        assertEqual(batcher.size, 2);
        assertEqual(batcher.drain().length, 2);
        assertEqual(batcher.size, 0);
        assertEqual(batcher.drain().length, 0);
        batcher.add('/c', 'upsert');
        batcher.clear();
        assertEqual(batcher.size, 0);
    }),
    test('property: random valid events never produce duplicate paths', () => {
        const random = seededRandom(0xc0ffee);
        const kinds = ['upsert', 'delete', 'dir-upsert', 'dir-delete'];
        for (let i = 0; i < 300; i++) {
            const batcher = new ChangeBatcher();
            const count = randomInt(random, 0, 20);
            for (let j = 0; j < count; j++) {
                const depth = randomInt(random, 1, 4);
                const parts = [];
                for (let k = 0; k < depth; k++)
                    parts.push(randomString(random, 'abc', 1, 3));
                batcher.add(`/${parts.join('/')}`, pick(random, kinds));
            }
            const changes = batcher.drain();
            const paths = new Set(changes.map(change => change.path));
            assertEqual(paths.size, changes.length);
            assertEqual(batcher.size, 0);
        }
    }),
]);
