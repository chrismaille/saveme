import {planChanges} from '../../../src/application/change-planner.js';
import {assert, assertEqual, suite, test} from '../../harness.js';
import {FakeFileSystem, FakeLogger} from './fakes.js';

function setup() {
    const files = new FakeFileSystem();
    files.addDir('/src');
    files.addDir('/src/dir');
    files.addDir('/src/dir/sub');
    files.addFile('/src/dir/a.txt');
    files.addFile('/src/file.txt');
    return {files, logger: new FakeLogger()};
}

function shape(plan) {
    return JSON.stringify(plan);
}

export default suite('application/change-planner', [
    test('ignores changes outside the source and newline paths', () => {
        const {files, logger} = setup();
        files.addFile('/src/bad\nname');
        const plan = planChanges({
            source: '/src',
            files,
            logger,
            changes: [
                {path: '/outside/file', kind: 'upsert'},
                {path: '/src/bad\nname', kind: 'upsert'},
            ],
        });
        assertEqual(shape(plan), shape({upserts: [], dirUpserts: [], deletes: [], dirDeletes: []}));
        assertEqual(logger.sink.length, 1);
        assert(/newline/.test(logger.sink[0].message));
    }),
    test('plans upserts, deletes and directory changes', () => {
        const {files, logger} = setup();
        const plan = planChanges({
            source: '/src',
            files,
            logger,
            changes: [
                {path: '/src/file.txt', kind: 'upsert'},
                {path: '/src/dir', kind: 'dir-upsert'},
                {path: '/src/missing.txt', kind: 'upsert'},
                {path: '/src/gone.txt', kind: 'delete'},
                {path: '/src/gone-dir', kind: 'dir-delete'},
            ],
        });
        assertEqual(JSON.stringify(plan), JSON.stringify({
            upserts: ['file.txt'],
            dirUpserts: ['dir'],
            deletes: ['gone.txt'],
            dirDeletes: ['gone-dir'],
        }));
    }),
    test('turns delete events for existing paths into upserts', () => {
        const {files, logger} = setup();
        const plan = planChanges({
            source: '/src',
            files,
            logger,
            changes: [
                {path: '/src/file.txt', kind: 'delete'},
                {path: '/src/dir', kind: 'dir-delete'},
            ],
        });
        assertEqual(JSON.stringify(plan), JSON.stringify({
            upserts: ['file.txt'],
            dirUpserts: ['dir'],
            deletes: [],
            dirDeletes: [],
        }));
    }),
    test('drops children covered by a parent directory upsert', () => {
        const {files, logger} = setup();
        const plan = planChanges({
            source: '/src',
            files,
            logger,
            changes: [
                {path: '/src/dir/a.txt', kind: 'upsert'},
                {path: '/src/dir/sub', kind: 'dir-upsert'},
                {path: '/src/dir/gone.txt', kind: 'delete'},
                {path: '/src/dir/gone-dir', kind: 'dir-delete'},
                {path: '/src/dir', kind: 'dir-upsert'},
            ],
        });
        assertEqual(JSON.stringify(plan.dirUpserts), JSON.stringify(['dir']));
        assertEqual(JSON.stringify(plan.upserts), '[]');
        assertEqual(JSON.stringify(plan.deletes), '[]');
        assertEqual(JSON.stringify(plan.dirDeletes), '[]');
    }),
    test('drops child deletes covered by a parent directory delete', () => {
        const {files, logger} = setup();
        const plan = planChanges({
            source: '/src',
            files,
            logger,
            changes: [
                {path: '/src/gone-dir/gone.txt', kind: 'delete'},
                {path: '/src/gone-dir/sub/gone.txt', kind: 'delete'},
                {path: '/src/gone-dir', kind: 'dir-delete'},
            ],
        });
        assertEqual(JSON.stringify(plan.dirDeletes), JSON.stringify(['gone-dir']));
        assertEqual(JSON.stringify(plan.deletes), '[]');
    }),
    test('ignores unsupported types and works without a logger', () => {
        const {files} = setup();
        files.nodes.set('/src/other', 'other');
        const plan = planChanges({
            source: '/src',
            files,
            logger: null,
            changes: [
                {path: '/src/other', kind: 'upsert'},
                {path: '/src/file.txt', kind: 'unknown'},
            ],
        });
        assertEqual(JSON.stringify(plan), JSON.stringify({
            upserts: [],
            dirUpserts: [],
            deletes: [],
            dirDeletes: [],
        }));
    }),
]);
