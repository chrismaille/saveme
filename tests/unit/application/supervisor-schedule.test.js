import {JobSupervisor} from '../../../src/supervisor.js';
import {assert, assertEqual, suite, test} from '../../harness.js';
import {FakeClock, FakeLogger, FakeState, makeJob} from './fakes.js';

function makeSupervisor(job, {idle = true} = {}) {
    const clock = new FakeClock(new Date(2026, 10, 14, 12, 0, 0).getTime());
    const state = new FakeState();
    const runs = [];
    let currentIdle = idle;
    const supervisor = new JobSupervisor({
        job,
        runner: {
            runFull: async (currentJob, options) => {
                runs.push({job: currentJob, options});
                return {
                    result: 'success',
                    kind: currentJob.type,
                    stats: {transfers: 0, bytes: 0},
                };
            },
        },
        state,
        logger: new FakeLogger(),
        pool: {run: fn => fn()},
        getSettings: () => ({}),
        clock,
        isIdle: () => currentIdle,
        onChange: () => {},
    });
    return {
        supervisor,
        clock,
        state,
        runs,
        setIdle: value => {
            currentIdle = value;
        },
    };
}

export default suite('application/supervisor-schedule', [
    test('idle-only defers a due run and retries when the computer becomes idle', async () => {
        const job = makeJob('backup', {
            source: {kind: 'local', path: '/tmp'},
            trigger: {mode: 'weekly', dayOfWeek: 6, time: '09:30', idleOnly: true},
        });
        const ctx = makeSupervisor(job, {idle: false});
        await ctx.supervisor._runFull({reason: 'schedule'});
        assertEqual(ctx.runs.length, 0);
        assertEqual(ctx.state.getJobState('job_test').status, 'waiting-idle');
        assert(ctx.supervisor.scheduler.has('idle'));

        ctx.setIdle(true);
        await ctx.supervisor._start();
        assertEqual(ctx.runs.length, 1);
        assertEqual(ctx.runs[0].options.reason, 'schedule');
        assertEqual(ctx.state.getJobState('job_test').status, 'idle');
        assert(ctx.supervisor.scheduler.has('interval'));
    }),
    test('manual runs ignore idle-only and draft jobs never run', async () => {
        const ctx = makeSupervisor(makeJob('backup', {
            source: {kind: 'local', path: '/tmp'},
            trigger: {mode: 'manual', idleOnly: true},
        }), {idle: false});
        await ctx.supervisor.runNow();
        assertEqual(ctx.runs.length, 1);

        const draft = makeSupervisor(makeJob('backup', {
            source: {kind: 'local', path: '/tmp'},
            draft: true,
            enabled: true,
            trigger: {mode: 'interval', intervalMinutes: 60},
        }));
        await draft.supervisor._start();
        assertEqual(draft.runs.length, 0);
        assertEqual(draft.state.getJobState('job_test').status, 'disabled');
        assertEqual(draft.supervisor.scheduler.size, 0);
    }),
    test('weekly jobs catch up a schedule missed while the daemon was stopped', async () => {
        const job = makeJob('backup', {
            source: {kind: 'local', path: '/tmp'},
            trigger: {mode: 'weekly', dayOfWeek: 6, time: '09:30'},
        });
        const overdue = makeSupervisor(job);
        overdue.state.setJobState('job_test', {
            lastRunAt: new Date(overdue.clock.nowMs() - 7 * 86_400_000).toISOString(),
        });
        await overdue.supervisor._start();
        assertEqual(overdue.runs.length, 1);

        const current = makeSupervisor(job);
        current.state.setJobState('job_test', {
            lastRunAt: new Date(current.clock.nowMs() - 60 * 60_000).toISOString(),
        });
        await current.supervisor._start();
        assertEqual(current.runs.length, 0);
        assert(current.supervisor.scheduler.has('interval'));
    }),
    test('interval jobs use intervalMinutes and retry a waiting-idle status', async () => {
        const ctx = makeSupervisor(makeJob('backup', {
            source: {kind: 'local', path: '/tmp'},
            trigger: {mode: 'interval', intervalMinutes: 1440},
        }));
        ctx.state.setJobState('job_test', {
            lastRunAt: new Date(ctx.clock.nowMs() - 60 * 60_000).toISOString(),
        });
        await ctx.supervisor._start();
        const timer = [...ctx.clock._timers.values()][0];
        assertEqual(timer.at - ctx.clock.nowMs(), 23 * 60 * 60_000);

        let started = false;
        ctx.supervisor.start = () => {
            started = true;
        };
        ctx.state.setJobState('job_test', {status: 'waiting-idle'});
        ctx.supervisor.retryIfWaiting();
        assertEqual(started, true);
    }),
]);
