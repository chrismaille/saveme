import GLib from 'gi://GLib';
import {ConfigStore} from '../../src/config.js';
import {JOB_TYPES, defaultJob} from '../../src/jobs.js';
import {
    assert,
    assertEqual,
    assertThrows,
    cleanup,
    suite,
    tempDir,
    test,
} from '../harness.js';

function makeStore(dir) {
    return new ConfigStore({
        path: GLib.build_filenamev([dir, 'config.json']),
        backupPath: GLib.build_filenamev([dir, 'config.json.bak']),
    });
}

function makeJob(name, source, destination) {
    return defaultJob({
        name,
        type: JOB_TYPES.SYNC,
        source: {kind: 'local', path: source},
        destination: {kind: 'local', path: destination},
        trigger: {mode: 'manual'},
    });
}

export default suite('config', [
    test('add, save and reload a job', async () => {
        const dir = tempDir('saveme-config');
        try {
            const store = makeStore(dir);
            store.load();
            const job = store.addJob(makeJob('Docs', '/tmp/src', '/tmp/dst'));
            assert(job.id);
            const reloaded = makeStore(dir);
            reloaded.load();
            assertEqual(reloaded.listJobs().length, 1);
            assertEqual(reloaded.getJob(job.id).name, 'Docs');
        } finally {
            cleanup(dir);
        }
    }),
    test('allows SaveMe jobs to share a base and rejects direct duplicates', async () => {
        const dir = tempDir('saveme-config-dest');
        try {
            const store = makeStore(dir);
            store.load();
            store.addJob(makeJob('One', '/tmp/src1', '/tmp/dst'));
            store.addJob(makeJob('Two', '/tmp/src2', '/tmp/dst'));
            assertEqual(store.listJobs().length, 2);
            const reloaded = makeStore(dir);
            reloaded.load();
            assertEqual(reloaded.listJobs().length, 2);

            const direct = makeJob('Direct', '/tmp/src3', '/tmp/dst-direct');
            direct.destinationLayout = 'direct';
            store.addJob(direct);
            const otherDirect = makeJob('Direct two', '/tmp/src4', '/tmp/dst-direct');
            otherDirect.destinationLayout = 'direct';
            await assertThrows(() => store.addJob(otherDirect),
                /cannot be shared/);
        } finally {
            cleanup(dir);
        }
    }),
    test('rejects removing a remote in use', async () => {
        const dir = tempDir('saveme-config-remote');
        try {
            const store = makeStore(dir);
            store.load();
            store.addRemote({
                name: 'drive',
                type: 'drive',
                label: 'Google Drive',
            });
            const job = makeJob('Cloud', '/tmp/src', '/tmp/dst');
            job.destination = {kind: 'remote', remote: 'drive', path: 'SaveMe'};
            store.addJob(job);
            await assertThrows(() => store.removeRemote('drive'), /used by jobs/);
        } finally {
            cleanup(dir);
        }
    }),
    test('legacy sync jobs stay direct while drafts use the SaveMe base', () => {
        const dir = tempDir('saveme-config-layout');
        try {
            const path = GLib.build_filenamev([dir, 'config.json']);
            const finalized = makeJob('Legacy', '/tmp/src1', '/tmp/dst1');
            delete finalized.destinationLayout;
            const draft = makeJob('Draft', '', '');
            draft.id = 'job_draft';
            draft.draft = true;
            draft.draftStep = 2;
            draft.enabled = false;
            delete draft.destinationLayout;
            GLib.file_set_contents(path, JSON.stringify({
                version: 1,
                settings: {},
                remotes: [],
                jobs: [finalized, draft],
            }));
            const store = makeStore(dir);
            store.load();
            assertEqual(store.getJob(finalized.id).destinationLayout, 'direct');
            assertEqual(store.getJob('job_draft').destinationLayout, 'saveMe');
        } finally {
            cleanup(dir);
        }
    }),
    test('drafts share destinations and do not block remote deletion', async () => {
        const dir = tempDir('saveme-config-drafts');
        try {
            const store = makeStore(dir);
            store.load();
            store.addRemote({name: 'drive', type: 'drive', label: 'Google Drive'});
            const first = makeJob('Draft one', '', '');
            first.draft = true;
            first.draftStep = 1;
            first.enabled = false;
            const second = makeJob('Draft two', '', '');
            second.draft = true;
            second.draftStep = 2;
            second.destination = {kind: 'remote', remote: 'drive', path: ''};
            second.enabled = false;
            store.addJob(first);
            store.addJob(second);
            assertEqual(store.listJobs().length, 2);
            store.removeRemote('drive');
            assertEqual(store.listRemoteNames().length, 0);
            const reloaded = makeStore(dir);
            reloaded.load();
            assertEqual(reloaded.listJobs().length, 2);
        } finally {
            cleanup(dir);
        }
    }),
]);
