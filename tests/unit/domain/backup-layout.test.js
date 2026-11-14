import {
    backupCurrentFor,
    backupRootFor,
    joinRclonePath,
    rcloneBasename,
    sourceFolderName,
    uniqueSourceFolderNames,
    versionDirFor,
    versionName,
    versionsRootFor,
} from '../../../src/domain/backup-layout.js';
import {assert, assertEqual, assertThrows, suite, test} from '../../harness.js';
import {pick, randomString, seededRandom} from './helpers.js';

function remoteJob(id = 'job_1') {
    return {id, destination: {kind: 'remote', remote: 'drive', path: ''}};
}

function localJob(id = 'job_1') {
    return {id, destination: {kind: 'local', path: '/tmp/dest'}};
}

export default suite('domain/backup-layout', [
    test('builds local current and versions roots', () => {
        const job = localJob('job_a');
        assertEqual(backupRootFor(job, '/tmp/dest'), '/tmp/dest/SaveMe/job_a');
        assertEqual(backupRootFor(job, '/tmp/dest///'), '/tmp/dest/SaveMe/job_a');
        assertEqual(backupRootFor(job, '/'), '/SaveMe/job_a');
        assertEqual(backupCurrentFor(job, '/tmp/dest'), '/tmp/dest/SaveMe/job_a/current');
        assertEqual(versionsRootFor(job, '/tmp/dest'), '/tmp/dest/SaveMe/job_a/versions');
    }),
    test('builds remote roots with and without a remote path', () => {
        const job = remoteJob('job_b');
        assertEqual(backupRootFor(job, 'drive:'), 'drive:SaveMe/job_b');
        assertEqual(backupRootFor(job, 'drive:Backups'), 'drive:Backups/SaveMe/job_b');
        assertEqual(backupRootFor(job, 'drive:Backups///'), 'drive:Backups/SaveMe/job_b');
        assertEqual(backupCurrentFor(job, 'drive:Backups'), 'drive:Backups/SaveMe/job_b/current');
        assertEqual(versionsRootFor(job, 'drive:Backups'), 'drive:Backups/SaveMe/job_b/versions');
    }),
    test('rejects a remote destination without a colon', () => {
        assertThrows(() => backupRootFor(remoteJob(), 'Backups'), /Invalid remote destination/);
    }),
    test('names source folders safely and disambiguates duplicates', () => {
        assertEqual(sourceFolderName({kind: 'local', path: '/home/me/Photos'}), 'Photos');
        assertEqual(sourceFolderName({kind: 'local', path: '/'}), 'source-1');
        assertEqual(sourceFolderName({kind: 'remote', remote: 'drive', path: ''}), 'source-1');
        assertEqual(sourceFolderName(null, 3), 'source-4');
        assertEqual(versionDirFor('/versions', 'run').includes('/versions/'), true);
        assertEqual(JSON.stringify(uniqueSourceFolderNames({
            source: {kind: 'local', path: '/a/Single'},
        })), JSON.stringify(['Single']));
        const names = uniqueSourceFolderNames({
            sources: [
                {kind: 'local', path: '/a/Photos'},
                {kind: 'local', path: '/b/Photos'},
                {kind: 'local', path: '/c/Docs'},
            ],
        });
        assertEqual(JSON.stringify(names),
            JSON.stringify(['Photos', 'Photos-2', 'Docs']));
    }),
    test('joinRclonePath handles roots, remote roots and relative paths', () => {
        assertEqual(joinRclonePath('drive:', 'a/b'), 'drive:a/b');
        assertEqual(joinRclonePath('drive:root/', 'a/b'), 'drive:root/a/b');
        assertEqual(joinRclonePath('drive:root', 'a/b'), 'drive:root/a/b');
        assertEqual(joinRclonePath('drive:root', ''), 'drive:root');
        assertEqual(joinRclonePath('/tmp/dest', 'a'), '/tmp/dest/a');
    }),
    test('rcloneBasename handles local, remote, root and empty paths', () => {
        assertEqual(rcloneBasename('/a/b/c.txt'), 'c.txt');
        assertEqual(rcloneBasename('/a/b/'), 'b');
        assertEqual(rcloneBasename('drive:foo/bar'), 'bar');
        assertEqual(rcloneBasename('drive:'), 'drive:');
        assertEqual(rcloneBasename('/'), '/');
        assertEqual(rcloneBasename(''), '');
        assertEqual(rcloneBasename(null), '');
    }),
    test('versionName and versionDirFor use the run suffix', () => {
        const date = new Date(2026, 0, 2, 3, 4, 5);
        assertEqual(versionName(date), '20260102T030405-000');
        assertEqual(versionName(date, 'run_abcdef'), '20260102T030405-000-abcdef');
        assertEqual(versionName(date, 'x'), '20260102T030405-000-x');
        assertEqual(
            versionDirFor('/tmp/dest/SaveMe/job/versions', 'run_abcdef', date),
            '/tmp/dest/SaveMe/job/versions/20260102T030405-000-abcdef',
        );
        const early = versionName(new Date(2026, 0, 2, 3, 4, 5, 100), 'run_a');
        const late = versionName(new Date(2026, 0, 2, 3, 4, 5, 200), 'run_b');
        assert(early < late, `${early} should sort before ${late}`);
    }),
    test('property: local roots preserve the destination and append SaveMe/job', () => {
        const random = seededRandom(0xbac0);
        for (let i = 0; i < 200; i++) {
            const id = `job_${randomString(random, 'abcdef0123456789', 4, 12)}`;
            const segmentCount = 1 + Math.floor(random() * 4);
            const segments = [];
            for (let j = 0; j < segmentCount; j++)
                segments.push(randomString(random, 'abcXYZ0123', 1, 8));
            const dest = `/${segments.join('/')}${pick(random, ['', '/', '///'])}`;
            const root = backupRootFor({id, destination: {kind: 'local'}}, dest);
            const expectedBase = dest.replace(/\/+$/, '');
            assertEqual(root, `${expectedBase}/SaveMe/${id}`);
            assert(root.startsWith('/'), root);
            assert(!root.includes('//'), root);
        }
    }),
    test('property: remote roots keep the remote name and append SaveMe/job', () => {
        const random = seededRandom(0x4e0e);
        for (let i = 0; i < 200; i++) {
            const id = `job_${randomString(random, 'abcdef0123456789', 4, 12)}`;
            const remote = pick(random, ['drive', 'onedrive', 'dropbox']);
            const path = randomString(random, 'abcXYZ0123/', 0, 20)
                .replace(/^\/+|\/+$/g, '')
                .replace(/\/+/g, '/');
            const dest = `${remote}:${path}${pick(random, ['', '/', '///'])}`;
            const root = backupRootFor({id, destination: {kind: 'remote'}}, dest);
            const expectedBase = path ? `${path}/SaveMe/${id}` : `SaveMe/${id}`;
            assertEqual(root, `${remote}:${expectedBase}`);
            assert(!root.includes('//'), root);
        }
    }),
]);
