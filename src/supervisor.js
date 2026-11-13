import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {ChangeQueue} from './queue.js';
import {RecursiveWatcher, WatcherLimitError} from './adapters/gio/watcher.js';
import {localPathFor, remotePathFor, TRIGGER_MODES} from './jobs.js';
import {uniqueId} from './util.js';
import {
    isCancelledRun,
    isSuccessfulRun,
    nextBackoffDelay,
    shouldRetryAfterRun,
    statusFromError,
} from './domain/run-state.js';

export class RunPool {
    constructor(limit = 1) {
        this.limit = Math.max(1, limit);
        this.active = 0;
        this.waiters = [];
    }

    async run(fn) {
        if (this.active >= this.limit)
            await new Promise(resolve => this.waiters.push(resolve));
        this.active++;
        try {
            return await fn();
        } finally {
            this.active--;
            const next = this.waiters.shift();
            if (next)
                next();
        }
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
        this.onChange = onChange;
        this.onRunFinished = onRunFinished;
        this.onNotify = onNotify;
        this._watcher = null;
        this._queue = null;
        this._timer = null;
        this._reconcileTimer = null;
        this._retryTimer = null;
        this._running = null;
        this._runningPromise = null;
        this._stopped = false;
        this._paused = Boolean(state.getJobState(job.id).paused);
        this._backoffIndex = 0;
        this._lastNotifyKey = null;
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

    start() {
        this._stopped = false;
        this._start().catch(e => {
            this.logger.error(`Cannot start job: ${e.message}`);
            this._setStatus('error', e.message);
            this._scheduleRetry();
        });
    }

    async _start() {
        if (this._stopped)
            return;
        this._clearTimers();
        this._stopRealtime();

        if (!this.job.enabled) {
            this._setStatus('disabled', '');
            return;
        }
        if (this._paused || this.state.pausedAll) {
            this._setStatus('paused', '');
            return;
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

        if (this.job.trigger.mode === TRIGGER_MODES.INTERVAL) {
            const intervalMs = Math.max(1, Number(this.job.trigger.intervalMinutes || 60)) * 60_000;
            const last = Date.parse(this.state.getJobState(this.job.id).lastRunAt || '');
            const elapsed = Number.isFinite(last) ? Date.now() - last : Infinity;
            if (elapsed >= intervalMs)
                await this._runFull({reason: 'interval'});
            else {
                this._setIdleStatus();
                this._scheduleInterval(intervalMs - elapsed);
            }
            return;
        }

        // Realtime: reconcile once, then watch (or poll for remote sources).
        await this._runFull({reason: 'startup'});
    }

    _resolveLocal(descriptor) {
        return localPathFor(descriptor, this.runner.volumes);
    }

    _checkAvailability() {
        let source;
        let dest;
        try {
            source = this.job.source.kind === 'local'
                ? this._resolveLocal(this.job.source)
                : remotePathFor(this.job.source);
        } catch (e) {
            return {sourceAvailable: false, destAvailable: true, message: e.message};
        }
        try {
            dest = this.job.destination.kind === 'local'
                ? this._resolveLocal(this.job.destination)
                : remotePathFor(this.job.destination);
        } catch (e) {
            return {sourceAvailable: true, destAvailable: false, message: e.message};
        }
        if (this.job.source.kind === 'local') {
            const file = Gio.File.new_for_path(source);
            if (!file.query_exists(null))
                return {sourceAvailable: false, destAvailable: true,
                    message: `Source does not exist: ${source}`};
            const type = file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            if (type !== Gio.FileType.DIRECTORY)
                return {sourceAvailable: false, destAvailable: true,
                    message: `Source is not a directory: ${source}`};
        }
        return {sourceAvailable: true, destAvailable: true, source, dest};
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
        if (!this.job.enabled)
            this._setStatus('disabled', '');
        else if (this._paused || this.state.pausedAll)
            this._setStatus('paused', '');
        else
            this._setStatus('idle', '');
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
            'needs-auth': 'SaveMe: authentication required',
            'delete-guard': 'SaveMe: deletion blocked',
            'paused': 'SaveMe: job paused',
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
            if (this._paused || this.state.pausedAll || !this.job.enabled)
                this._setStatus('paused', 'Cancelled');
            else {
                const availability = this._checkAvailability();
                if (!availability.sourceAvailable)
                    this._setStatus('waiting-source', availability.message || 'Source unavailable');
                else
                    this._setStatus('paused', 'Cancelled');
            }
            return;
        }
        if (isSuccessfulRun(run.result)) {
            this._backoffIndex = 0;
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
            }
            this._setIdleStatus();
            return;
        }

        // Error path.
        const message = run.message || 'Unknown error';
        const status = statusFromError(message);
        this._stopRealtime();
        this._setStatus(status, message);
        this._notify(status, message);
        if (shouldRetryAfterRun(status, this.job.trigger.mode))
            this._scheduleRetry();
        this.logger.warn(`Run failed (${status}, incremental=${incremental}): ${message}`);
    }

    async _runFull({reason = 'manual', dryRun = false, force = false, runId = null} = {}) {
        if (this._running)
            return null;
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
        if (this._watcher || this._timer || this._stopped || this._paused ||
            this.state.pausedAll || !this.job.enabled)
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
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, minutes * 60, () => {
            this._timer = null;
            if (!this._stopped && !this._paused && !this.state.pausedAll) {
                this._runFull({reason: 'poll'}).catch(e =>
                    this.logger.warn(`Poll failed: ${e.message}`));
            }
            return GLib.SOURCE_REMOVE;
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
        if (this._reconcileTimer) {
            GLib.source_remove(this._reconcileTimer);
            this._reconcileTimer = null;
        }
    }

    _scheduleReconcile() {
        if (this._reconcileTimer) {
            GLib.source_remove(this._reconcileTimer);
            this._reconcileTimer = null;
        }
        const hours = Number(this.getSettings()?.reconcileIntervalHours || 24);
        if (hours <= 0)
            return;
        this._reconcileTimer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, hours * 3600, () => {
                this._reconcileTimer = null;
                if (!this._stopped && !this._paused && !this.state.pausedAll) {
                    this._runFull({reason: 'reconcile'}).catch(e =>
                        this.logger.warn(`Reconcile failed: ${e.message}`));
                }
                return GLib.SOURCE_REMOVE;
            });
    }

    _scheduleInterval(delayMs = null) {
        this._clearIntervalTimer();
        const interval = Math.max(1, Number(this.job.trigger.intervalMinutes || 60)) * 60_000;
        const delay = delayMs ?? interval;
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._timer = null;
            if (!this._stopped && !this._paused && !this.state.pausedAll) {
                this._runFull({reason: 'interval'}).catch(e =>
                    this.logger.warn(`Interval run failed: ${e.message}`));
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleRetry() {
        this._clearRetryTimer();
        const delay = nextBackoffDelay(this._backoffIndex);
        this._backoffIndex++;
        this._retryTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._retryTimer = null;
            if (!this._stopped && !this._paused && !this.state.pausedAll)
                this._start().catch(e => this.logger.warn(`Retry failed: ${e.message}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearPollTimer() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
    }

    _clearIntervalTimer() {
        this._clearPollTimer();
    }

    _clearRetryTimer() {
        if (this._retryTimer) {
            GLib.source_remove(this._retryTimer);
            this._retryTimer = null;
        }
    }

    _clearTimers() {
        this._clearPollTimer();
        this._clearRetryTimer();
        if (this._reconcileTimer) {
            GLib.source_remove(this._reconcileTimer);
            this._reconcileTimer = null;
        }
    }

    pause() {
        this._paused = true;
        this._clearTimers();
        this._stopRealtime();
        this.cancel();
        try {
            this.state.setJobState(this.job.id, {
                paused: true,
                status: 'paused',
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
            this.state.setJobState(this.job.id, {paused: false});
        } catch (_) {
            // Best effort.
        }
        this.start();
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
        this._setStatus('paused', '');
    }

    resumeFromGlobal() {
        if (!this._paused)
            this.start();
    }

    async runNow({dryRun = false, force = false, runId = null} = {}) {
        if (this._running)
            throw new Error('Job is already running.');
        return this._runFull({reason: 'manual', dryRun, force, runId});
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
            status === 'offline')
            this.start();
    }

    runIfOverdue() {
        if (this._stopped || this._paused || this.state.pausedAll || !this.job.enabled)
            return;
        if (this.job.trigger.mode === TRIGGER_MODES.INTERVAL) {
            const interval = Math.max(1, Number(this.job.trigger.intervalMinutes || 60)) * 60_000;
            const last = Date.parse(this.state.getJobState(this.job.id).lastRunAt || '');
            if (!Number.isFinite(last) || Date.now() - last >= interval)
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
            polling: Boolean(this._timer),
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
        onChange = null,
        onRunFinished = null,
        onNotify = null,
    }) {
        this.config = config;
        this.state = state;
        this.runner = runner;
        this.logger = logger;
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
            supervisor.start();
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
        // Cancelling a run stops the job. This avoids a running watcher
        // immediately starting a new run after the user pressed Cancel.
        supervisor.cancel();
        supervisor.pause();
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
