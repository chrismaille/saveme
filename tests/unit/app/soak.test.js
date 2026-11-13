import {buildSoakSnapshot} from '../../../app/observability/soak.js';
import {assert, assertEqual, suite, test} from '../../harness.js';

const NOW = Date.parse('2026-01-31T12:00:00Z');

export default suite('app/observability/soak', [
    test('creates a synthetic job and exercises progress states', () => {
        const snapshot = buildSoakSnapshot({}, 0, NOW);
        assertEqual(snapshot.jobs.length, 1);
        assertEqual(snapshot.jobs[0].state.status, 'running');
        assertEqual(snapshot.jobs[0].state.progress.files, 0);
        assertEqual(snapshot.pausedAll, true);
        const idle = buildSoakSnapshot({}, 1, NOW);
        assertEqual(idle.jobs[0].state.status, 'idle');
        assertEqual(idle.jobs[0].state.progress, undefined);
        assertEqual(idle.pausedAll, false);
    }),
    test('deep-clones the base snapshot and keeps job ids stable', () => {
        const base = {
            jobs: [{
                id: 'job_1',
                name: 'Daily',
                type: 'backup',
                state: {status: 'idle'},
            }],
            remotes: [{name: 'drive'}],
        };
        const first = buildSoakSnapshot(base, 3, NOW);
        const second = buildSoakSnapshot(base, 4, NOW);
        assertEqual(first.jobs[0].id, 'job_1');
        assertEqual(second.jobs[0].id, 'job_1');
        assertEqual(JSON.stringify(base.jobs[0].state), JSON.stringify({status: 'idle'}));
        assert(first !== second);
        assertEqual(first.remotes[0].name, 'drive');
    }),
]);
