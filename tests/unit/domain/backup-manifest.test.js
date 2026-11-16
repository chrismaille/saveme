import {
    parseBackupManifest,
    serializeBackupManifest,
} from '../../../src/domain/backup-manifest.js';
import {assert, assertEqual, assertThrows, suite, test} from '../../harness.js';

const job = {
    id: 'job_1',
    name: 'Photos',
    type: 'backup',
    source: {kind: 'local', path: '/home/me/photos'},
    sources: [
        {kind: 'local', path: '/home/me/photos'},
        {kind: 'local', path: '/home/me/docs'},
    ],
    destination: {kind: 'remote', remote: 'onedrive', path: 'Backups'},
    trigger: {mode: 'interval', intervalMinutes: 60},
    filters: {exclude: []},
    options: {notifyOnComplete: true},
    backup: {retentionDays: 30},
};

export default suite('domain/backup-manifest', [
    test('round-trips the job and keeps multiple sources', () => {
        const text = serializeBackupManifest(job, {
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
        });
        assert(text.includes('"version": 1'));
        const parsed = parseBackupManifest(text);
        assertEqual(parsed.id, 'job_1');
        assertEqual(parsed.type, 'backup');
        assertEqual(parsed.sources.length, 2);
        assertEqual(parsed.source.path, '/home/me/photos');
        assertEqual(parsed.trigger.intervalMinutes, 60);
        assertEqual(parsed.options.notifyOnComplete, true);
    }),
    test('rejects malformed or unsupported manifests', async () => {
        await assertThrows(() => parseBackupManifest('not json'), /Invalid backup manifest/);
        await assertThrows(() => parseBackupManifest('null'), /Unsupported backup manifest/);
        await assertThrows(() => parseBackupManifest('{}'), /Unsupported backup manifest/);
        await assertThrows(() => parseBackupManifest(JSON.stringify({
            version: 1,
            job: null,
        })), /Unsupported backup manifest/);
        await assertThrows(() => parseBackupManifest(JSON.stringify({
            version: 2,
            job: {},
        })), /Unsupported backup manifest/);
        const sync = parseBackupManifest(JSON.stringify({
            version: 1,
            job: {
                id: 'x',
                type: 'sync',
                source: {kind: 'local', path: '/a'},
                destination: {kind: 'local', path: '/b'},
                trigger: {mode: 'interval', intervalMinutes: 60},
                filters: {exclude: []},
                options: {},
                backup: {},
            },
        }));
        assertEqual(sync.type, 'sync');
    }),
    test('serializes a legacy job without sources from its source field', () => {
        const text = serializeBackupManifest({
            id: 'legacy',
            name: 'Legacy',
            type: 'backup',
            source: {kind: 'local', path: '/legacy'},
            destination: {kind: 'local', path: '/dest'},
        });
        const parsed = parseBackupManifest(text);
        assertEqual(parsed.sources.length, 1);
        assertEqual(parsed.source.path, '/legacy');
    }),
]);
