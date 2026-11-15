import {JobSupervisor, RunPool} from '../../../src/supervisor.js';
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
    test('stopped jobs stay stopped until Play, which clears the hold', async () => {
        const ctx = makeSupervisor(makeJob('backup', {
            source: {kind: 'local', path: '/tmp'},
            trigger: {mode: 'interval', intervalMinutes: 60},
        }));
        ctx.supervisor.stopByUser();
        assertEqual(ctx.state.getJobState('job_test').status, 'stopped');
        assertEqual(ctx.state.getJobState('job_test').stopped, true);
        assertEqual(ctx.supervisor.scheduler.size, 0);

        await ctx.supervisor._start();
        assertEqual(ctx.state.getJobState('job_test').status, 'stopped');
        assertEqual(ctx.runs.length, 0);

        await ctx.supervisor.play();
        assertEqual(ctx.runs.length, 1);
        assertEqual(ctx.state.getJobState('job_test').stopped, false);
        assertEqual(ctx.state.getJobState('job_test').status, 'idle');
    }),
    test('interrupted backups resume once when the daemon starts', async () => {
        const job = makeJob('backup', {
            source: {kind: 'local', path: '/tmp'},
            trigger: {mode: 'interval', intervalMinutes: 60},
        });
        const ctx = makeSupervisor(job);
        ctx.state.setJobState('job_test', {
            status: 'error',
            lastResult: 'error',
            interrupted: true,
        });
        ctx.supervisor._resumeInterrupted = true;
        await ctx.supervisor._start();
        assertEqual(ctx.runs.length, 1);
        assertEqual(ctx.runs[0].options.reason, 'resume');
        assertEqual(ctx.state.getJobState('job_test').interrupted, false);
        assertEqual(ctx.state.getJobState('job_test').status, 'idle');

        const clean = makeSupervisor(job);
        clean.state.setJobState('job_test', {
            status: 'idle',
            lastResult: 'success',
            lastRunAt: clean.clock.nowIso(),
            interrupted: false,
        });
        clean.supervisor._resumeInterrupted = true;
        await clean.supervisor._start();
        assertEqual(clean.runs.length, 0);
    }),
    test('cancelling a stopped run reports the stopped status', () => {
        const ctx = makeSupervisor(makeJob('backup', {
            source: {kind: 'local', path: '/tmp'},
            trigger: {mode: 'manual'},
        }));
        ctx.state.setJobState('job_test', {stopped: true});
        ctx.supervisor._paused = true;
        ctx.supervisor._handleRunResult({result: 'cancelled', kind: 'backup'});
        assertEqual(ctx.state.getJobState('job_test').status, 'stopped');
    }),
    test('RunPool reports when a run has to wait for a slot', async () => {
        const pool = new RunPool(1);
        let release = null;
        const gate = new Promise(resolve => {
            release = resolve;
        });
        const first = pool.run(async () => {
            await gate;
        });
        let waited = false;
        const second = pool.run(async () => {}, () => {
            waited = true;
        });
        await Promise.resolve();
        assertEqual(waited, true);
        release();
        await Promise.all([first, second]);
    }),
    test('RunPool applies a higher concurrency limit immediately', async () => {
        const pool = new RunPool(1);
        const started = [];
        let release = null;
        const gate = new Promise(resolve => {
            release = resolve;
        });
        const first = pool.run(async () => {
            started.push(1);
            await gate;
        });
        const second = pool.run(async () => {
            started.push(2);
        });
        await Promise.resolve();
        assertEqual(started.length, 1);
        pool.setLimit(2);
        await Promise.resolve();
        await Promise.resolve();
        assertEqual(started.length, 2);
        release();
        await Promise.all([first, second]);
        assertEqual(pool.active, 0);
    }),
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
