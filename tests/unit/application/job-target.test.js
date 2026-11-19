import {resolveJobTargets} from '../../../src/application/job-target.js';
import {VolumeUnavailableError} from '../../../src/domain/errors.js';
import {assertEqual, assertThrows, suite, test} from '../../harness.js';
import {FakeFileSystem} from './fakes.js';

function localJob(overrides = {}) {
    return {
        source: {kind: 'local', path: '/src'},
        destination: {kind: 'local', path: '/dst'},
        ...overrides,
    };
}

export default suite('application/job-target', [
    test('resolves local source and destination directories', () => {
        const files = new FakeFileSystem();
        files.addDir('/src');
        files.addDir('/dst');
        const result = resolveJobTargets(localJob(), {files, volumes: null});
        assertEqual(result.source, '/src');
        assertEqual(result.dest, '/dst');
        assertEqual(result.sourceIsLocal, true);
        assertEqual(result.destIsLocal, true);
    }),
    test('sync jobs resolve to their own SaveMe folder unless direct', () => {
        const files = new FakeFileSystem();
        files.addDir('/src');
        files.addDir('/dst');
        const saveMe = resolveJobTargets(localJob({
            id: 'job_1',
            type: 'sync',
            destinationLayout: 'saveMe',
        }), {files, volumes: null});
        assertEqual(saveMe.dest, '/dst/SaveMe/job_1/current');
        assertEqual(saveMe.destBase, '/dst');
        const direct = resolveJobTargets(localJob({
            id: 'job_1',
            type: 'sync',
            destinationLayout: 'direct',
        }), {files, volumes: null});
        assertEqual(direct.dest, '/dst');
    }),
    test('rejects missing, non-directory and incomplete local targets', async () => {
        const missingSource = new FakeFileSystem();
        missingSource.addDir('/dst');
        await assertThrows(() => resolveJobTargets(localJob(), {
            files: missingSource, volumes: null,
        }), /Source does not exist/);

        const fileSource = new FakeFileSystem();
        fileSource.addFile('/src');
        fileSource.addDir('/dst');
        await assertThrows(() => resolveJobTargets(localJob(), {
            files: fileSource, volumes: null,
        }), /Source is not a directory/);

        const fileDest = new FakeFileSystem();
        fileDest.addDir('/src');
        fileDest.addFile('/dst');
        await assertThrows(() => resolveJobTargets(localJob(), {
            files: fileDest, volumes: null,
        }), /Destination is not a directory/);

        await assertThrows(() => resolveJobTargets(localJob({source: null}), {
            files: new FakeFileSystem(), volumes: null,
        }), /required/);
    }),
    test('rejects a source descriptor without a path', async () => {
        await assertThrows(() => resolveJobTargets({
            source: {kind: 'local', path: ''},
            destination: {kind: 'local', path: '/dst'},
        }, {files: new FakeFileSystem(), volumes: null}), /required/);
    }),
    test('resolves remote and mixed targets without touching the filesystem', () => {        const files = new FakeFileSystem();
        files.addDir('/src');
        files.addDir('/dst');

        const remoteSource = resolveJobTargets(localJob({
            source: {kind: 'remote', remote: 'drive', path: 'Backups'},
        }), {files, volumes: null});
        assertEqual(remoteSource.source, 'drive:Backups');
        assertEqual(remoteSource.sourceIsLocal, false);

        const remoteDest = resolveJobTargets(localJob({
            destination: {kind: 'remote', remote: 'dropbox'},
        }), {files, volumes: null});
        assertEqual(remoteDest.dest, 'dropbox:');
        assertEqual(remoteDest.destIsLocal, false);

        const both = resolveJobTargets(localJob({
            source: {kind: 'remote', remote: 'drive', path: 'a'},
            destination: {kind: 'remote', remote: 'drive', path: 'b'},
        }), {files, volumes: null});
        assertEqual(both.source, 'drive:a');
        assertEqual(both.dest, 'drive:b');
    }),
    test('rejects an unmounted source or destination volume', async () => {
        const files = new FakeFileSystem();
        files.addDir('/src');
        files.addDir('/dst');
        const volumes = {
            resolve(descriptor) {
                throw new VolumeUnavailableError(descriptor);
            },
        };
        await assertThrows(() => resolveJobTargets(localJob({
            source: {
                kind: 'local', path: '/mnt/dados/Omega',
                volumeUuid: 'uuid-a', volumeName: 'Dados', relativePath: 'Omega',
            },
        }), {files, volumes}), /Source disk is unavailable: Dados/);
        await assertThrows(() => resolveJobTargets(localJob({
            destination: {
                kind: 'local', path: '/mnt/backups',
                volumeUuid: 'uuid-b', volumeName: 'Backup', relativePath: '',
            },
        }), {files, volumes}), /Destination disk is unavailable: Backup/);
        await assertThrows(() => resolveJobTargets(localJob({
            source: {
                kind: 'local', path: '/mnt/dados/Omega',
                volumeUuid: 'uuid-a', volumeName: 'Dados', relativePath: 'Omega',
            },
        }), {
            files,
            volumes: {
                resolve() {
                    throw new Error('resolver failed');
                },
            },
        }), /resolver failed/);
    }),
]);
