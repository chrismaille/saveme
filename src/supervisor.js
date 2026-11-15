import Gio from 'gi://Gio';
import {ChangeQueue} from './queue.js';
import {RecursiveWatcher, WatcherLimitError} from './adapters/gio/watcher.js';
import {jobSources, localPathFor, remotePathFor, JOB_TYPES, TRIGGER_MODES} from './jobs.js';
import {humanBytes, uniqueId} from './util.js';
import {isRunOverdue, nextRunDelay} from './domain/schedule.js';
import {
    isCancelledRun,
    isSuccessfulRun,
    shouldRetryAfterRun,
} from './domain/run-state.js';
import {cancelledStatus, failureStatus, idleStatus} from './domain/job-state-machine.js';
import {RetryPolicy} from './domain/retry-policy.js';
import {Scheduler} from './application/scheduler.js';

export class RunPool {
    constructor(limit = 1) {
        this.limit = Math.max(1, Number(limit) || 1);
        this.active = 0;
        this.waiters = [];
    }

    async run(fn, onWait = null) {
        let notified = false;
        while (this.active >= this.limit) {
            if (!notified) {
                notified = true;
                onWait?.();
            }
            await new Promise(resolve => this.waiters.push(resolve));
        }
        this.active++;
        try {
            return await fn();
        } finally {
            this.active--;
            this._wake();
        }
    }

    setLimit(limit) {
        this.limit = Math.max(1, Number(limit) || 1);
        this._wake();
    }

    _wake() {
        const waiters = this.waiters.splice(0);
        for (const wake of waiters)
            wake();
    }
}

export class JobSupervisor {
    constructor({
        job,
        runner,
        state,
        logger,
        pool,
        getSettings,
        clock,
        isIdle = () => true,
        onChange = null,
        onRunFinished = null,
        onNotify = null,
    }) {
        this.job = job;
        this.runner = runner;
        this.state = state;
        this.logger = logger.child(job.name || job.id);
        this.pool = pool;
        this.getSettings = getSettings;
        this.clock = clock;
        this.isIdle = isIdle;
        this.scheduler = new Scheduler({clock, logger: this.logger});
        this.retryPolicy = new RetryPolicy();
        this.onChange = onChange;
        this.onRunFinished = onRunFinished;
        this.onNotify = onNotify;
        this._watcher = null;
        this._queue = null;
        this._running = null;
        this._runningPromise = null;
        this._stopped = false;
        this._paused = Boolean(state.getJobState(job.id).paused);
        this._lastNotifyKey = null;
        this._pendingDueRun = false;
        this._pendingDueReason = null;
        this._resumeInterrupted = false;
    }

    get id() {
        return this.job.id;
    }

    get running() {
        return Boolean(this._running);
    }

    updateJob(job) {
        this.cancel();
        this.job = job;
    }

    start({resumeInterrupted = false} = {}) {
        this._stopped = false;
        this._resumeInterrupted = resumeInterrupted;
        this._start().catch(e => {
            this.logger.error(`Cannot start job: ${e.message}`);
            this._setStatus('error', e.message);
            this._scheduleRetry();
        });
    }

    async _start() {
        if (this._running && this._runningPromise) {
            try {
                await this._runningPromise;
            } catch (_) {
                // The new configuration still needs to start.
            }
        }
        if (this._stopped)
            return;
        this._clearTimers();
        this._stopRealtime();

        if (!this.job.enabled) {
            this._setStatus('disabled', '');
            return;
        }
        if (this.job.draft) {
            this._setStatus('disabled', 'Draft');
            return;
        }
        if (this._paused || this.state.pausedAll) {
            const stopped = Boolean(this.state.getJobState(this.job.id).stopped);
            this._setStatus(stopped ? 'stopped' : 'paused', '');
            return;
        }

        if (this._resumeInterrupted) {
            this._resumeInterrupted = false;
            const persisted = this.state.getJobState(this.job.id);
            const interrupted = Boolean(persisted.interrupted) ||
                persisted.lastResult === 'cancelled';
            if (this.job.type === JOB_TYPES.BACKUP &&
                this.job.trigger.mode !== TRIGGER_MODES.MANUAL &&
                interrupted) {
                await this._runFull({reason: 'resume'});
                return;
            }
        }

        const availability = this._checkAvailability();
        if (!availability.sourceAvailable) {
            this._setStatus('waiting-source', availability.message || 'Source unavailable');
            this._scheduleRetry();
            return;
        }
        if (!availability.destAvailable) {
            this._setStatus('waiting-destination',
                availability.message || 'Destination unavailable');
            this._scheduleRetry();
            return;
        }

        if (this.job.trigger.mode === TRIGGER_MODES.MANUAL) {
            this._setIdleStatus();
            return;
        }

        // A scheduled run was due but the computer was busy. Retry it now
        // instead of skipping to the next weekly/monthly occurrence.
        if (this._pendingDueRun) {
            const reason = this._pendingDueReason || 'schedule';
            this._pendingDueRun = false;
            this._pendingDueReason = null;
            await this._runFull({reason});
            return;
        }

        if (this.job.trigger.mode === TRIGGER_MODES.STARTUP) {
            await this._runFull({reason: 'startup'});
            return;
        }

        if ([TRIGGER_MODES.WEEKLY, TRIGGER_MODES.MONTHLY, TRIGGER_MODES.DUSK]
            .includes(this.job.trigger.mode)) {
            const last = Date.parse(this.state.getJobState(this.job.id).lastRunAt || '');
            if (isRunOverdue(this.job.trigger, last, this.clock.nowMs())) {
                await this._runFull({reason: 'schedule'});
                return;
            }
        }

        if (this.job.trigger.mode === TRIGGER_MODES.INTERVAL) {
            const intervalMs = Math.max(1, Number(this.job.trigger.intervalMinutes || 60)) * 60_000;
            const last = Date.parse(this.state.getJobState(this.job.id).lastRunAt || '');
            const elapsed = Number.isFinite(last) ? this.clock.nowMs() - last : Infinity;
            if (elapsed >= intervalMs)
                await this._runFull({reason: 'interval'});
            else {
                this._setIdleStatus();
                this._scheduleNext(intervalMs - elapsed);
            }
            return;
        }

        if (this.job.trigger.mode === TRIGGER_MODES.REALTIME) {
            // Realtime: reconcile once, then watch (or poll for remote sources).
            await this._runFull({reason: 'startup'});
            return;
        }

        const delay = nextRunDelay(this.job.trigger, this.clock.nowMs());
        this._setIdleStatus();
        if (delay !== null)
            this._scheduleNext(delay);
    }

    _resolveLocal(descriptor) {
        return localPathFor(descriptor, this.runner.volumes);
    }

    _checkAvailability() {
        const sources = jobSources(this.job);
        for (const [index, source] of sources.entries()) {
            const label = sources.length > 1 ? `Source ${index + 1}` : 'Source';
            let resolved;
            try {
                resolved = source.kind === 'local'
                    ? this._resolveLocal(source)
                    : remotePathFor(source);
            } catch (e) {
                return {sourceAvailable: false, destAvailable: true, message: e.message};
            }
            if (source.kind === 'local') {
                const file = Gio.File.new_for_path(resolved);
                if (!file.query_exists(null)) {
                    return {sourceAvailable: false, destAvailable: true,
                        message: `${label} does not exist: ${resolved}`};
                }
                const type = file.query_file_type(
                    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
                if (type !== Gio.FileType.DIRECTORY) {
                    return {sourceAvailable: false, destAvailable: true,
                        message: `${label} is not a directory: ${resolved}`};
                }
            }
        }
        let dest;
        try {
            dest = this.job.destination.kind === 'local'
                ? this._resolveLocal(this.job.destination)
                : remotePathFor(this.job.destination);
        } catch (e) {
            return {sourceAvailable: true, destAvailable: false, message: e.message};
        }
        return {sourceAvailable: true, destAvailable: true, source: sources[0], dest};
    }

    _setStatus(status, message = '') {
        try {
            this.state.setJobState(this.job.id, {status, message});
        } catch (e) {
            this.logger.warn(`Cannot set state: ${e.message}`);
        }
        this.onChange?.();
    }

    _setIdleStatus() {
        this._setStatus(idleStatus({
            enabled: this.job.enabled,
            paused: this._paused,
            pausedAll: this.state.pausedAll,
        }), '');
    }

    _notify(status, message) {
        if (status === 'idle' || status === 'disabled')
            return;
        const key = `${status}:${message}`;
        if (key === this._lastNotifyKey)
            return;
        this._lastNotifyKey = key;
        const titles = {
            'error': 'SaveMe: job failed',
            'waiting-source': 'SaveMe: source unavailable',
            'waiting-destination': 'SaveMe: destination unavailable',
            'waiting-idle': 'SaveMe: waiting for the computer to be idle',
            'needs-auth': 'SaveMe: authentication required',
            'delete-guard': 'SaveMe: deletion blocked',
            'paused': 'SaveMe: job paused',
            'success': 'SaveMe: backup completed',
        };
        this.onNotify?.({
            job: this.job,
            status,
            title: titles[status] || 'SaveMe',
            body: message || this.job.name,
        });
    }

    _handleRunResult(run, {incremental = false} = {}) {
        if (!run || this._stopped)
            return;
        this.onRunFinished?.(run);
        if (isCancelledRun(run.result)) {
            const availability = this._paused || this.state.pausedAll || !this.job.enabled
                ? {sourceAvailable: true}
                : this._checkAvailability();
            const status = cancelledStatus({
                enabled: this.job.enabled,
                paused: this._paused,
                stopped: Boolean(this.state.getJobState(this.job.id).stopped),
                pausedAll: this.state.pausedAll,
                sourceAvailable: availability.sourceAvailable,
            });
            this._setStatus(status,
                status === 'waiting-source'
                    ? availability.message || 'Source unavailable'
                    : 'Cancelled');
            return;
        }
        if (isSuccessfulRun(run.result)) {
            this.retryPolicy.reset();
            this._lastNotifyKey = null;
            if (this.job.trigger.mode === TRIGGER_MODES.REALTIME) {
                this._startRealtime().catch(e => {
                    this.logger.error(`Cannot start realtime sync: ${e.message}`);
                    this._setStatus('error', e.message);
                    this._scheduleRetry();
                });
                this._scheduleReconcile();
            } else if (this.job.trigger.mode === TRIGGER_MODES.INTERVAL) {
                this._scheduleInterval();
            } else if (![TRIGGER_MODES.MANUAL, TRIGGER_MODES.STARTUP]
                .includes(this.job.trigger.mode)) {
                const delay = nextRunDelay(this.job.trigger, this.clock.nowMs());
                if (delay !== null)
                    this._scheduleNext(delay);
            }
            this._setIdleStatus();
            if (run.kind === 'backup' && this.job.options?.notifyOnComplete !== false) {
                const stats = run.stats || {};
                this._notify('success',
                    `${this.job.name || this.job.id}: ${stats.transfers || 0} file(s), ` +
                    `${humanBytes(stats.bytes || 0)}`);
            }
            return;
        }

        // Error path.
        const message = run.message || 'Unknown error';
        const status = failureStatus(message);
        this._stopRealtime();
        this._setStatus(status, message);
        this._notify(status, message);
        if (shouldRetryAfterRun(status, this.job.trigger.mode))
            this._scheduleRetry();
        this.logger.warn(`Run failed (${status}, incremental=${incremental}): ${message}`);
    }

    async _runFull({reason = 'manual', dryRun = false, force = false, runId = null,
        ignoreIdle = false} = {}) {
        if (this._running)
            return null;
        if (!ignoreIdle && this.job.trigger?.idleOnly && !this.isIdle()) {
            this._pendingDueRun = true;
            this._pendingDueReason = reason;
            this._setStatus('waiting-idle', 'Waiting for the computer to be idle');
            this._scheduleIdleRetry();
            return null;
        }
        this._pendingDueRun = false;
        this._pendingDueReason = null;
        try {
            this.state.setJobState(this.job.id, {interrupted: false});
        } catch (_) {
            // Best effort.
        }
        const id = runId || uniqueId('run_');
        const cancellable = new Gio.Cancellable();
        this._running = {cancellable, runId: id};
        try {
            this._runningPromise = this.pool.run(async () => {
                if (cancellable.is_cancelled())
                    return null;
                return this.runner.runFull(this.job, {
                    dryRun,
                    force,
                    reason,
                    cancellable,
                    runId: id,
                    onProgress: () => this.onChange?.(),
                });
            }, () => {
                if (!this._stopped && !this._paused && !this.state.pausedAll)
                    this._setStatus('queued', 'Waiting for a free job slot');
            });
            const run = await this._runningPromise;
            this._handleRunResult(run);
            return run;
        } finally {
            this._running = null;
            this._runningPromise = null;
        }
    }

    async _runIncremental(changes) {
        if (this._running) {
            try {
                await this._runningPromise;
            } catch (_) {
                // Ignore; the batch will be retried on the next event.
            }
        }
        if (this._stopped || this._paused || this.state.pausedAll || !this.job.enabled)
            return null;
        if (this._running)
            return null;
        const runId = uniqueId('run_');
        const cancellable = new Gio.Cancellable();
        this._running = {cancellable, runId};
        try {
            this._runningPromise = this.pool.run(() => this.runner.runIncremental(
                this.job, changes, {
                    cancellable,
                    runId,
                    onProgress: () => this.onChange?.(),
                }));
            const run = await this._runningPromise;
            this._handleRunResult(run, {incremental: true});
            return run;
        } finally {
            this._running = null;
            this._runningPromise = null;
        }
    }

    async _startRealtime() {
        if (this._watcher || this.scheduler.has('poll') || this.scheduler.has('interval') ||
            this._stopped || this._paused || this.state.pausedAll || !this.job.enabled)
            return;
        if (this.job.source.kind !== 'local') {
            this._startPolling();
            return;
        }
        const source = this._resolveLocal(this.job.source);
        this._queue = new ChangeQueue({
            logger: this.logger,
            onFlush: changes => this._runIncremental(changes),
        });
        this._watcher = new RecursiveWatcher({
            rootPath: source,
            logger: this.logger,
            onChange: change => this._queue?.add(change.path, change.kind),
            onUnavailable: () => {
                this.logger.warn('Source became unavailable');
                this._stopRealtime();
                this._setStatus('waiting-source', `Source disappeared: ${source}`);
                this._notify('waiting-source', `Source disappeared: ${source}`);
                this._scheduleRetry();
            },
            onError: error => {
                this.logger.warn(`Watcher error: ${error.message}`);
                this._stopRealtime();
                this._setStatus('error', error.message);
                this._notify('error', error.message);
                this._scheduleRetry();
            },
        });
        try {
            await this._watcher.start();
            this._setIdleStatus();
        } catch (e) {
            this._stopRealtime();
            if (e instanceof WatcherLimitError) {
                this.logger.warn(`${e.message}; falling back to polling`);
                this._startPolling();
            } else {
                throw e;
            }
        }
    }

    _startPolling() {
        this._clearPollTimer();
        const minutes = Math.max(1, Number(this.getSettings()?.pollIntervalMinutes || 5));
        this.scheduler.start('poll', minutes * 60 * 1000, () => {
            if (!this._stopped && !this._paused && !this.state.pausedAll) {
                this._runFull({reason: 'poll'}).catch(e =>
                    this.logger.warn(`Poll failed: ${e.message}`));
            }
        });
        this._setIdleStatus();
    }

    _stopRealtime() {
        if (this._watcher) {
            this._watcher.stop();
            this._watcher = null;
        }
        if (this._queue) {
            this._queue.stop();
            this._queue = null;
        }
        this._clearPollTimer();
        this.scheduler.clear('reconcile');
    }

    _scheduleReconcile() {
        this.scheduler.clear('reconcile');
        const hours = Number(this.getSettings()?.reconcileIntervalHours || 24);
        if (hours <= 0)
            return;
        this.scheduler.start('reconcile', hours * 3600 * 1000, () => {
            if (!this._stopped && !this._paused && !this.state.pausedAll) {
                this._runFull({reason: 'reconcile'}).catch(e =>
                    this.logger.warn(`Reconcile failed: ${e.message}`));
            }
        });
    }

    _scheduleInterval(delayMs = null) {
        this._clearIntervalTimer();
        const interval = Math.max(1, Number(this.job.trigger.intervalMinutes || 60)) * 60_000;
        const delay = delayMs ?? interval;
        this.scheduler.start('interval', delay, () => {
            if (!this._stopped && !this._paused && !this.state.pausedAll) {
                this._runFull({reason: 'interval'}).catch(e =>
                    this.logger.warn(`Interval run failed: ${e.message}`));
            }
        });
    }

    _scheduleNext(delayMs) {
        this._clearIntervalTimer();
        this.scheduler.start('interval', Math.max(0, delayMs), () => {
            if (!this._stopped && !this._paused && !this.state.pausedAll) {
                this._runFull({reason: 'schedule'}).catch(e =>
                    this.logger.warn(`Scheduled run failed: ${e.message}`));
            }
        });
    }

    _scheduleIdleRetry() {
        if (this.scheduler.has('idle'))
            return;
        this.scheduler.start('idle', 5 * 60_000, () => {
            if (!this._stopped && !this._paused && !this.state.pausedAll)
                this._start().catch(e => this.logger.warn(`Idle retry failed: ${e.message}`));
        });
    }

    _scheduleRetry() {
        this._clearRetryTimer();
        const delay = this.retryPolicy.nextDelay();
        this.scheduler.start('retry', delay, () => {
            if (!this._stopped && !this._paused && !this.state.pausedAll)
                this._start().catch(e => this.logger.warn(`Retry failed: ${e.message}`));
        });
    }

    _clearPollTimer() {
        this.scheduler.clear('poll');
    }

    _clearIntervalTimer() {
        this.scheduler.clear('interval');
    }

    _clearRetryTimer() {
        this.scheduler.clear('retry');
    }

    _clearTimers() {
        this.scheduler.clearAll();
    }

    pause() {
        this._paused = true;
        this._clearTimers();
        this._stopRealtime();
        this.cancel();
        try {
            this.state.setJobState(this.job.id, {
                paused: true,
                stopped: false,
                status: 'paused',
                message: '',
                progress: null,
            });
        } catch (_) {
            // Best effort.
        }
        this.onChange?.();
    }

    stopByUser() {
        this._paused = true;
        this._clearTimers();
        this._stopRealtime();
        this.cancel();
        try {
            this.state.setJobState(this.job.id, {
                paused: true,
                stopped: true,
                status: 'stopped',
                message: '',
                progress: null,
            });
        } catch (_) {
            // Best effort.
        }
        this.onChange?.();
    }

    resume() {
        this._paused = false;
        try {
            this.state.setJobState(this.job.id, {
                paused: false,
                stopped: false,
            });
        } catch (_) {
            // Best effort.
        }
        this.start();
    }

    async play({dryRun = false, force = false, runId = null} = {}) {
        if (this._running)
            throw new Error('Job is already running.');
        this._stopped = false;
        this._paused = false;
        this._resumeInterrupted = false;
        this._clearTimers();
        this._stopRealtime();
        try {
            this.state.setJobState(this.job.id, {
                paused: false,
                stopped: false,
                interrupted: false,
                status: 'idle',
                message: '',
                progress: null,
            });
        } catch (_) {
            // Best effort.
        }
        return this._runFull({reason: 'manual', dryRun, force, runId, ignoreIdle: true});
    }

    suspend() {
        this._clearTimers();
        this._stopRealtime();
        this.cancel();
        try {
            this.state.setJobState(this.job.id, {progress: null});
        } catch (_) {
            // Best effort.
        }
        const stopped = Boolean(this.state.getJobState(this.job.id).stopped);
        this._setStatus(stopped ? 'stopped' : 'paused', '');
    }

    resumeFromGlobal() {
        if (!this._paused)
            this.start();
    }

    async runNow({dryRun = false, force = false, runId = null} = {}) {
        if (this._running)
            throw new Error('Job is already running or queued.');
        return this._runFull({reason: 'manual', dryRun, force, runId, ignoreIdle: true});
    }

    cancel() {
        if (this._running) {
            this.logger.info(`Cancelling run ${this._running.runId}`);
            this._running.cancellable.cancel();
        }
    }

    retryIfWaiting() {
        const status = this.state.getJobState(this.job.id).status;
        if (status === 'waiting-source' || status === 'waiting-destination' ||
            status === 'waiting-idle' || status === 'offline')
            this.start();
    }

    runIfOverdue() {
        if (this._stopped || this._paused || this.state.pausedAll || !this.job.enabled)
            return;
        if (this.job.trigger.mode === TRIGGER_MODES.INTERVAL) {
            const interval = Math.max(1, Number(this.job.trigger.intervalMinutes || 60)) * 60_000;
            const last = Date.parse(this.state.getJobState(this.job.id).lastRunAt || '');
            if (!Number.isFinite(last) || this.clock.nowMs() - last >= interval)
                this.start();
        }
    }

    stop() {
        this._stopped = true;
        this._clearTimers();
        this._stopRealtime();
        this.cancel();
    }

    snapshot() {
        return {
            job: this.job,
            state: this.state.getJobState(this.job.id),
            watching: Boolean(this._watcher),
            polling: this.scheduler.has('poll') || this.scheduler.has('interval'),
            running: Boolean(this._running),
        };
    }
}

export class JobManager {
    constructor({
        config,
        state,
        runner,
        logger,
        clock,
        isIdle = () => true,
        onChange = null,
        onRunFinished = null,
        onNotify = null,
    }) {
        this.config = config;
        this.state = state;
        this.runner = runner;
        this.logger = logger;
        this.clock = clock;
        this.isIdle = isIdle;
        this.onChange = onChange;
        this.onRunFinished = onRunFinished;
        this.onNotify = onNotify;
        this.pool = new RunPool(Number(config.settings.maxConcurrentJobs || 1));
        this.supervisors = new Map();
    }

    getSettings() {
        return this.config.settings;
    }

    start() {
        this.reload();
    }

    reload() {
        this.stopAll();
        this.pool = new RunPool(Number(this.config.settings.maxConcurrentJobs || 1));
        this.supervisors.clear();
        for (const job of this.config.listJobs()) {
            const supervisor = this._createSupervisor(job);
            this.supervisors.set(job.id, supervisor);
        }
        for (const supervisor of this.supervisors.values())
            supervisor.start({resumeInterrupted: true});
        this.onChange?.();
    }

    _createSupervisor(job) {
        return new JobSupervisor({
            job,
            runner: this.runner,
            state: this.state,
            logger: this.logger,
            pool: this.pool,
            getSettings: () => this.getSettings(),
            clock: this.clock,
            isIdle: this.isIdle,
            onChange: this.onChange,
            onRunFinished: this.onRunFinished,
            onNotify: this.onNotify,
        });
    }

    addJob(job) {
        if (this.supervisors.has(job.id))
            return this.updateJob(job.id, job);
        const supervisor = this._createSupervisor(job);
        this.supervisors.set(job.id, supervisor);
        supervisor.start();
        this.onChange?.();
    }

    updateJob(jobId, job) {
        const supervisor = this.supervisors.get(jobId);
        if (!supervisor)
            return this.addJob(job);
        supervisor.updateJob(job);
        if (job.enabled)
            supervisor.start();
        else {
            supervisor.stop();
            supervisor._setStatus('disabled', '');
        }
        this.onChange?.();
    }

    removeJob(jobId) {
        const supervisor = this.supervisors.get(jobId);
        if (supervisor) {
            supervisor.stop();
            this.supervisors.delete(jobId);
        }
        this.onChange?.();
    }

    stopAll() {
        for (const supervisor of this.supervisors.values())
            supervisor.stop();
    }

    get(jobId) {
        return this.supervisors.get(jobId) || null;
    }

    async runJob(jobId, options = {}) {
        const supervisor = this.get(jobId);
        if (!supervisor)
            throw new Error(`Job not found: ${jobId}`);
        return supervisor.runNow(options);
    }

    cancelJob(jobId) {
        const supervisor = this.get(jobId);
        if (!supervisor)
            throw new Error(`Job not found: ${jobId}`);
        // Stopping a job also stops its recurrence until the user presses Play.
        supervisor.stopByUser();
    }

    async playJob(jobId, options = {}) {
        const supervisor = this.get(jobId);
        if (!supervisor)
            throw new Error(`Job not found: ${jobId}`);
        return supervisor.play(options);
    }

    setConcurrency(limit) {
        this.pool.setLimit(limit);
    }

    pauseJob(jobId, paused) {
        const supervisor = this.get(jobId);
        if (!supervisor)
            throw new Error(`Job not found: ${jobId}`);
        if (paused)
            supervisor.pause();
        else
            supervisor.resume();
    }

    pauseAll(paused) {
        this.state.setPausedAll(paused);
        for (const supervisor of this.supervisors.values()) {
            if (paused)
                supervisor.suspend();
            else
                supervisor.resumeFromGlobal();
        }
        this.onChange?.();
    }

    onMountChanged() {
        for (const supervisor of this.supervisors.values())
            supervisor.retryIfWaiting();
        this.onChange?.();
    }

    onNetworkChanged(available) {
        if (!available)
            return;
        for (const supervisor of this.supervisors.values())
            supervisor.retryIfWaiting();
        this.onChange?.();
    }

    onResume() {
        for (const supervisor of this.supervisors.values())
            supervisor.runIfOverdue();
        this.onChange?.();
    }

    snapshot() {
        return [...this.supervisors.values()].map(supervisor => supervisor.snapshot());
    }
}
