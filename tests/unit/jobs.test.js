import {
    JOB_TYPES,
    TRIGGER_MODES,
    defaultJob,
    descriptorFromString,
    descriptorToString,
    normalizeJob,
    validateJob,
} from '../../src/jobs.js';
import {assert, assertEqual, suite, test} from '../harness.js';

function makeJob(overrides = {}) {
    return defaultJob({
        name: 'Test',
        type: JOB_TYPES.SYNC,
        source: {kind: 'local', path: '/tmp/source'},
        destination: {kind: 'local', path: '/tmp/destination'},
        ...overrides,
    });
}

export default suite('jobs', [
    test('defaultJob has safe defaults', () => {
        const job = defaultJob();
        assertEqual(job.type, JOB_TYPES.SYNC);
        assertEqual(job.options.maxDeletePercent, 10);
        assertEqual(job.options.maxDeleteMinimum, 10);
        assertEqual(job.backup.retentionDays, 30);
        assertEqual(job.trigger.mode, TRIGGER_MODES.REALTIME);
    }),
    test('normalizeJob fills missing options', () => {
        const job = normalizeJob({
            name: 'x',
            type: 'backup',
            source: {kind: 'local', path: '/tmp/a'},
            destination: {kind: 'local', path: '/tmp/b'},
        });
        assertEqual(job.options.maxDeleteMinimum, 10);
        assertEqual(job.options.transfers, 4);
        assertEqual(job.backup.retentionDays, 30);
    }),
    test('validateJob rejects overlapping local paths', () => {
        const job = makeJob({
            source: {kind: 'local', path: '/tmp/a'},
            destination: {kind: 'local', path: '/tmp/a/b'},
        });
        assert(validateJob(job).some(error => /dentro/.test(error)));
    }),
    test('validateJob rejects equal local paths', () => {
        const job = makeJob({
            source: {kind: 'local', path: '/tmp/a'},
            destination: {kind: 'local', path: '/tmp/a'},
        });
        assert(validateJob(job).some(error => /iguais/.test(error)));
    }),
    test('validateJob accepts separate local paths', () => {
        const job = makeJob({
            source: {kind: 'local', path: '/tmp/a'},
            destination: {kind: 'local', path: '/tmp/b'},
        });
        assertEqual(validateJob(job).length, 0);
    }),
    test('validateJob rejects unknown remotes', () => {
        const job = makeJob({
            source: {kind: 'local', path: '/tmp/a'},
            destination: {kind: 'remote', remote: 'missing', path: 'x'},
        });
        assert(validateJob(job, {remotes: ['drive']}).some(error => /desconhecido/.test(error)));
    }),
    test('validateJob rejects overlapping remote paths', () => {
        const job = makeJob({
            source: {kind: 'remote', remote: 'drive', path: 'a'},
            destination: {kind: 'remote', remote: 'drive', path: 'a/b'},
        });
        assert(validateJob(job).some(error => /mesmo caminho/.test(error)));
    }),
    test('descriptorFromString parses known remotes and local paths', () => {
        const remote = descriptorFromString('drive:Backups/Photos', {
            remotes: ['drive'],
        });
        assertEqual(remote.kind, 'remote');
        assertEqual(remote.remote, 'drive');
        assertEqual(remote.path, 'Backups/Photos');
        const local = descriptorFromString('/tmp/foo', {remotes: ['drive']});
        assertEqual(local.kind, 'local');
        assertEqual(local.path, '/tmp/foo');
    }),
    test('descriptorToString round-trips remotes', () => {
        assertEqual(descriptorToString({
            kind: 'remote', remote: 'drive', path: 'x',
        }), 'drive:x');
        assertEqual(descriptorToString({
            kind: 'local', path: '/tmp/x',
        }), '/tmp/x');
    }),
]);
