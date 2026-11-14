import {
    JOB_TYPES,
    TRIGGER_MODES,
    cloneJob,
    descriptorDisplay,
    descriptorFromString,
    descriptorKey,
    descriptorToString,
    isLocalDescriptor,
    isRemoteDescriptor,
    jobDefaults,
    jobRemoteNames,
    jobSources,
    localPathFor,
    normalizeJobFields,
    remotePathFor,
    remotePathsOverlap,
    validateJobFields,
} from '../../../src/domain/job.js';
import {assert, assertEqual, suite, test} from '../../harness.js';

function baseJob(overrides = {}) {
    return {
        id: 'job_1',
        name: 'Test',
        type: JOB_TYPES.SYNC,
        enabled: true,
        source: {kind: 'local', path: '/tmp/source'},
        destination: {kind: 'local', path: '/tmp/destination'},
        trigger: {mode: TRIGGER_MODES.REALTIME},
        filters: {exclude: []},
        options: {
            maxDeletePercent: 10,
            maxDeleteMinimum: 10,
            bandwidthLimit: '',
            transfers: 4,
            checkers: 8,
            preserveMetadata: false,
            followSymlinks: false,
        },
        backup: {retentionDays: 30},
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

export default suite('domain/job', [
    test('jobDefaults applies defaults and injected id/clock', () => {
        assertEqual(jobDefaults().id, '');
        assertEqual(jobDefaults({name: 'x'}).name, 'x');
        const job = jobDefaults({name: 'x'}, {
            idFactory: () => 'job_custom',
            now: () => '2026-01-02T03:04:05.000Z',
        });
        assertEqual(job.id, 'job_custom');
        assertEqual(job.name, 'x');
        assertEqual(job.type, JOB_TYPES.SYNC);
        assertEqual(job.trigger.mode, TRIGGER_MODES.REALTIME);
        assertEqual(job.options.transfers, 4);
        assertEqual(job.backup.retentionDays, 30);
        assertEqual(job.createdAt, '2026-01-02T03:04:05.000Z');
        assertEqual(job.updatedAt, '2026-01-02T03:04:05.000Z');
    }),
    test('jobDefaults merges nested overrides', () => {
        const job = jobDefaults({
            id: 'given',
            options: {transfers: 2},
            filters: {exclude: ['*.tmp']},
        }, {idFactory: () => 'ignored', now: () => 'now'});
        assertEqual(job.id, 'given');
        assertEqual(job.options.transfers, 2);
        assertEqual(job.options.checkers, 8);
        assertEqual(JSON.stringify(job.filters.exclude), JSON.stringify(['*.tmp']));
    }),
    test('normalizeJobFields fills sources from the legacy source field', () => {
        const job = normalizeJobFields(baseJob());
        assertEqual(job.sources.length, 1);
        assertEqual(job.sources[0].path, '/tmp/source');
        assertEqual(job.source.path, '/tmp/source');
        assertEqual(job.options.notifyOnComplete, true);
        const multi = normalizeJobFields(baseJob({
            type: JOB_TYPES.BACKUP,
            sources: [
                {kind: 'local', path: '/a'},
                {kind: 'local', path: '/b'},
            ],
        }));
        assertEqual(jobSources(multi).length, 2);
        assertEqual(multi.source.path, '/a');
    }),
    test('validation distinguishes sync and multi-source backup rules', () => {
        const sync = baseJob({
            sources: [
                {kind: 'local', path: '/a'},
                {kind: 'local', path: '/b'},
            ],
        });
        assert(validateJobFields(sync).some(error => /exactly one source/.test(error)));
        const backup = baseJob({
            type: JOB_TYPES.BACKUP,
            trigger: {mode: TRIGGER_MODES.INTERVAL, intervalMinutes: 60},
            sources: [
                {kind: 'local', path: '/a'},
                {kind: 'local', path: '/b'},
            ],
        });
        assertEqual(validateJobFields(backup).length, 0);
        const realtime = {...backup, trigger: {mode: TRIGGER_MODES.REALTIME}};
        assert(validateJobFields(realtime).some(error => /interval or manual/.test(error)));
    }),
    test('jobRemoteNames includes every remote source', () => {
        const job = baseJob({
            sources: [
                {kind: 'remote', remote: 'drive', path: 'a'},
                {kind: 'remote', remote: 'onedrive', path: 'b'},
            ],
            destination: {kind: 'remote', remote: 'dropbox', path: 'c'},
        });
        assertEqual(JSON.stringify(jobRemoteNames(job).sort()),
            JSON.stringify(['drive', 'dropbox', 'onedrive']));
    }),
    test('jobSources and path helpers tolerate missing descriptors', () => {
        assertEqual(jobSources(null).length, 0);
        assertEqual(jobSources({source: {kind: 'local', path: '/a'}}).length, 1);
        assertEqual(localPathFor(null), null);
        assertEqual(localPathFor({kind: 'local', path: ''}), null);
        assertEqual(remotePathFor(null), null);
        assertEqual(remotePathFor({kind: 'remote', remote: 'drive'}), 'drive:');
        const empty = normalizeJobFields(baseJob({sources: [], source: null}));
        assertEqual(empty.sources.length, 0);
        assertEqual(empty.source, null);
    }),
    test('jobRemoteNames ignores local sources and missing destination remotes', () => {
        const job = baseJob({
            sources: [{kind: 'local', path: '/a'}],
            destination: {kind: 'local', path: '/b'},
        });
        assertEqual(jobRemoteNames(job).length, 0);
    }),
    test('validation rejects duplicates and realtime multi-source backup', () => {
        const duplicate = baseJob({
            type: JOB_TYPES.BACKUP,
            trigger: {mode: TRIGGER_MODES.INTERVAL, intervalMinutes: 60},
            sources: [
                {kind: 'local', path: '/a'},
                {kind: 'local', path: '/a'},
            ],
        });
        assert(validateJobFields(duplicate).some(error => /duplicadas/.test(error)));
        const realtime = baseJob({
            type: JOB_TYPES.BACKUP,
            trigger: {mode: TRIGGER_MODES.REALTIME},
            sources: [
                {kind: 'remote', remote: 'drive', path: 'a'},
                {kind: 'remote', remote: 'drive', path: 'b'},
            ],
            destination: {kind: 'remote', remote: 'drive', path: 'a/b'},
        });
        assert(validateJobFields(realtime).some(error => /interval or manual/.test(error)));
        assert(validateJobFields(realtime).some(error => /mesmo caminho/.test(error)));
    }),
    test('recovered jobs tolerate remotes not yet configured', () => {
        const job = baseJob({
            type: JOB_TYPES.BACKUP,
            recovered: true,
            trigger: {mode: TRIGGER_MODES.MANUAL},
            sources: [{kind: 'remote', remote: 'onedrive', path: 'a'}],
            destination: {kind: 'remote', remote: 'onedrive', path: 'b'},
        });
        assertEqual(validateJobFields(job, {remotes: ['drive']}).length, 0);
    }),
    test('normalizeJobFields repairs invalid values', () => {
        const job = normalizeJobFields(baseJob({
            id: '',
            type: 'invalid',
            trigger: {mode: 'invalid'},
            filters: {exclude: null},
            options: {
                maxDeletePercent: 'x',
                maxDeleteMinimum: 'x',
                transfers: 0,
                checkers: -1,
            },
            backup: {retentionDays: 'x'},
            enabled: 0,
        }));
        assertEqual(job.id, '');
        assertEqual(job.type, JOB_TYPES.SYNC);
        assertEqual(job.trigger.mode, TRIGGER_MODES.REALTIME);
        assertEqual(JSON.stringify(job.filters.exclude), '[]');
        assertEqual(job.options.maxDeletePercent, 10);
        assertEqual(job.options.maxDeleteMinimum, 10);
        assertEqual(job.options.transfers, 0);
        assertEqual(job.options.checkers, -1);
        assertEqual(job.backup.retentionDays, 30);
        assertEqual(job.enabled, false);
    }),
    test('normalizeJobFields keeps valid values', () => {
        const job = normalizeJobFields(baseJob({
            type: JOB_TYPES.BACKUP,
            trigger: {mode: TRIGGER_MODES.INTERVAL, intervalMinutes: 5},
            filters: {exclude: ['x']},
            options: {transfers: 2, checkers: 3},
            backup: {retentionDays: 7},
            enabled: true,
        }));
        assertEqual(job.type, JOB_TYPES.BACKUP);
        assertEqual(job.trigger.mode, TRIGGER_MODES.INTERVAL);
        assertEqual(JSON.stringify(job.filters.exclude), JSON.stringify(['x']));
        assertEqual(job.options.transfers, 2);
        assertEqual(job.options.checkers, 3);
        assertEqual(job.backup.retentionDays, 7);
        assertEqual(job.enabled, true);
    }),
    test('descriptor predicates handle missing descriptors', () => {
        assertEqual(isLocalDescriptor({kind: 'local'}), true);
        assertEqual(isLocalDescriptor({kind: 'remote'}), false);
        assertEqual(isLocalDescriptor(null), false);
        assertEqual(isRemoteDescriptor({kind: 'remote'}), true);
        assertEqual(isRemoteDescriptor({kind: 'local'}), false);
        assertEqual(isRemoteDescriptor(null), false);
    }),
    test('descriptorToString handles remotes, locals and null', () => {
        assertEqual(descriptorToString(null), '');
        assertEqual(descriptorToString({kind: 'remote', remote: 'drive', path: 'x'}), 'drive:x');
        assertEqual(descriptorToString({kind: 'remote', remote: 'drive'}), 'drive:');
        assertEqual(descriptorToString({kind: 'local', path: '/tmp/x'}), '/tmp/x');
        assertEqual(descriptorToString({kind: 'local'}), '');
    }),
    test('descriptorKey handles remotes, volumes and locals', () => {
        assertEqual(descriptorKey(null), '');
        assertEqual(descriptorKey({
            kind: 'remote', remote: 'drive', path: '/a/b/',
        }), 'remote:drive:a/b');
        assertEqual(descriptorKey({
            kind: 'remote', remote: 'drive',
        }), 'remote:drive:');
        assertEqual(descriptorKey({
            kind: 'local', volumeUuid: 'uuid', relativePath: 'a/b',
        }), 'volume:uuid:a/b');
        assertEqual(descriptorKey({
            kind: 'local', volumeUuid: 'uuid',
        }), 'volume:uuid:');
        assertEqual(descriptorKey({
            kind: 'local', path: '~/x',
        }, {canonicalize: value => `/canonical${value}`}), 'local:/canonical~/x');
        assertEqual(descriptorKey({kind: 'local'}), 'local:');
    }),
    test('descriptorDisplay handles remotes, volumes and locals', () => {
        assertEqual(descriptorDisplay(null), '');
        assertEqual(descriptorDisplay({kind: 'remote', remote: 'drive', path: 'x'}), 'drive:x');
        assertEqual(descriptorDisplay({
            kind: 'local', volumeUuid: 'uuid', relativePath: 'a/b',
        }, {volumeName: () => 'USB'}), 'USB:a/b');
        assertEqual(descriptorDisplay({
            kind: 'local', volumeUuid: 'uuid', relativePath: 'a/b',
        }, {volumeName: () => null}), 'uuid:a/b');
        assertEqual(descriptorDisplay({
            kind: 'local', volumeUuid: 'uuid', relativePath: 'a/b',
        }), '');
        assertEqual(descriptorDisplay({
            kind: 'local', volumeUuid: 'uuid',
        }, {volumeName: () => 'USB'}), 'USB:/');
        assertEqual(descriptorDisplay({
            kind: 'local', path: '/tmp/x',
        }), '/tmp/x');
    }),
    test('descriptorFromString handles local:, known remotes, unknown remotes and fallback', () => {
        assertEqual(JSON.stringify(descriptorFromString('local:/tmp/x')),
            JSON.stringify({kind: 'local', path: '/tmp/x'}));
        assertEqual(JSON.stringify(descriptorFromString('local:/tmp/x', {
            makeLocal: path => ({kind: 'local', path, fromVolume: true}),
        })), JSON.stringify({kind: 'local', path: '/tmp/x', fromVolume: true}));
        assertEqual(JSON.stringify(descriptorFromString('drive:Backups', {
            remotes: ['drive'],
        })), JSON.stringify({kind: 'remote', remote: 'drive', path: 'Backups'}));
        assertEqual(JSON.stringify(descriptorFromString('missing:Backups', {
            remotes: ['drive'],
        })), JSON.stringify({kind: 'local', path: 'missing:Backups'}));
        assertEqual(JSON.stringify(descriptorFromString('/tmp/foo', {
            makeLocal: path => ({kind: 'local', path, fromVolume: true}),
        })), JSON.stringify({kind: 'local', path: '/tmp/foo', fromVolume: true}));
        assertEqual(JSON.stringify(descriptorFromString('/tmp/foo')), JSON.stringify({
            kind: 'local',
            path: '/tmp/foo',
        }));
        assertEqual(JSON.stringify(descriptorFromString()), JSON.stringify({
            kind: 'local',
            path: '',
        }));
    }),
    test('remotePathsOverlap detects equal, nested and unrelated paths', () => {
        assertEqual(remotePathsOverlap({remote: 'a', path: 'x'}, {remote: 'b', path: 'x'}), false);
        assertEqual(remotePathsOverlap({remote: 'a', path: 'x'}, {remote: 'a', path: 'x'}), true);
        assertEqual(remotePathsOverlap({remote: 'a', path: ''}, {remote: 'a', path: 'x'}), true);
        assertEqual(remotePathsOverlap({remote: 'a', path: 'x'}, {remote: 'a', path: ''}), true);
        assertEqual(remotePathsOverlap({remote: 'a', path: 'x/y'}, {remote: 'a', path: 'x'}), true);
        assertEqual(remotePathsOverlap({remote: 'a', path: 'x'}, {remote: 'a', path: 'x/y'}), true);
        assertEqual(remotePathsOverlap({remote: 'a', path: 'x'}, {remote: 'a', path: 'y'}), false);
    }),
    test('validateJobFields accepts a valid job', () => {
        assertEqual(validateJobFields(baseJob()).length, 0);
    }),
    test('validateJobFields rejects invalid job shapes and descriptors', () => {
        assertEqual(JSON.stringify(validateJobFields(null)), JSON.stringify(['Job inválido.']));
        assert(validateJobFields(baseJob({name: ''})).some(error => /nome/.test(error)));
        assert(validateJobFields(baseJob({type: 'nope'})).some(error => /tipo/.test(error)));
        assert(validateJobFields(baseJob({source: null})).some(error => /origem/.test(error)));
        assert(validateJobFields(baseJob({
            source: {kind: 'local'},
        })).some(error => /caminho/.test(error)));
        assert(validateJobFields(baseJob({
            source: {kind: 'local', volumeUuid: 'u'},
        })).some(error => /relativo/.test(error)));
        assert(validateJobFields(baseJob({
            destination: {kind: 'remote'},
        })).some(error => /remote/.test(error)));
        assert(validateJobFields(baseJob({
            destination: {kind: 'remote', remote: 'missing', path: 'x'},
        }), {remotes: ['drive']}).some(error => /desconhecido/.test(error)));
        assertEqual(validateJobFields(baseJob({
            destination: {kind: 'remote', remote: 'missing', path: 'x'},
        }), {remotes: []}).length, 0);
        assert(validateJobFields(baseJob({
            source: {kind: 'remote', remote: 'drive', path: 'a'},
            destination: {kind: 'remote', remote: 'drive', path: 'a/b'},
        })).some(error => /mesmo caminho/.test(error)));
        assertEqual(validateJobFields(baseJob({
            source: {kind: 'remote', remote: 'drive', path: 'a'},
            destination: {kind: 'remote', remote: 'drive', path: 'b'},
        })).length, 0);
        assertEqual(validateJobFields(baseJob({
            source: {kind: 'remote', remote: 'drive', path: 'a'},
        })).length, 0);
        assertEqual(validateJobFields(baseJob({
            destination: {kind: 'remote', remote: 'drive', path: 'b'},
        })).length, 0);
        assertEqual(validateJobFields({
            name: 'x',
            type: JOB_TYPES.SYNC,
            source: {kind: 'remote', remote: 'drive', path: 'a'},
            destination: undefined,
            trigger: {mode: TRIGGER_MODES.REALTIME},
        }).length, 1);
        assertEqual(validateJobFields(baseJob({
            options: undefined,
            backup: undefined,
        })).length, 0);
        assertEqual(validateJobFields({
            name: 'x',
            type: JOB_TYPES.SYNC,
            source: undefined,
            destination: undefined,
            trigger: {mode: TRIGGER_MODES.REALTIME},
        }).length, 2);
    }),
    test('validateJobFields validates trigger, interval and numeric limits', () => {
        assert(validateJobFields(baseJob({
            trigger: null,
        })).some(error => /agendamento/.test(error)));
        assert(validateJobFields(baseJob({
            trigger: {mode: TRIGGER_MODES.INTERVAL, intervalMinutes: 0},
        })).some(error => /intervalo/.test(error)));
        assertEqual(validateJobFields(baseJob({
            trigger: {mode: TRIGGER_MODES.INTERVAL, intervalMinutes: 5},
        })).length, 0);
        assert(validateJobFields(baseJob({
            options: {maxDeletePercent: -1},
        })).some(error => /limite/.test(error)));
        assert(validateJobFields(baseJob({
            options: {maxDeletePercent: 101},
        })).some(error => /limite/.test(error)));
        assert(validateJobFields(baseJob({
            options: {maxDeleteMinimum: -1},
        })).some(error => /mínimo/.test(error)));
        assert(validateJobFields(baseJob({
            options: {transfers: 0},
        })).some(error => /transferências/.test(error)));
        assert(validateJobFields(baseJob({
            options: {checkers: 0},
        })).some(error => /checkers/.test(error)));
        assert(validateJobFields(baseJob({
            backup: {retentionDays: -1},
        })).some(error => /retenção/.test(error)));
    }),
    test('jobRemoteNames collects unique remote names', () => {
        assertEqual(JSON.stringify(jobRemoteNames({})), '[]');
        assertEqual(JSON.stringify(jobRemoteNames(baseJob())), '[]');
        assertEqual(JSON.stringify(jobRemoteNames(baseJob({
            source: {kind: 'remote', remote: 'drive', path: ''},
            destination: {kind: 'remote', remote: 'drive', path: 'x'},
        }))), JSON.stringify(['drive']));
        assertEqual(JSON.stringify(jobRemoteNames(baseJob({
            source: {kind: 'remote', remote: 'drive', path: ''},
            destination: {kind: 'remote', remote: 'dropbox', path: 'x'},
        }))), JSON.stringify(['drive', 'dropbox']));
        assertEqual(JSON.stringify(jobRemoteNames(baseJob({
            source: {kind: 'remote', remote: 'drive', path: ''},
        }))), JSON.stringify(['drive']));
        assertEqual(JSON.stringify(jobRemoteNames(baseJob({
            destination: {kind: 'remote', remote: 'dropbox', path: 'x'},
        }))), JSON.stringify(['dropbox']));
    }),
    test('cloneJob deep-clones the job', () => {
        const job = baseJob();
        const copy = cloneJob(job);
        copy.options.transfers = 99;
        assertEqual(job.options.transfers, 4);
        assertEqual(copy.options.transfers, 99);
    }),
]);
