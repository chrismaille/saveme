import {
    DEFAULT_LOG_POLICY,
    planLogCleanup,
    summarizeLogEntries,
} from '../domain/log-policy.js';

const AREAS = new Set(['daemon', 'jobs']);
const SCOPES = new Set(['all', 'daemon', 'runs', 'run-logs']);

function numberOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export class LogService {
    constructor({
        store,
        getSettings = () => ({}),
        logger = null,
        clock = {nowMs: () => Date.now()},
        onClearDaemon = null,
        onCloseDaemonLog = null,
    }) {
        this.store = store;
        this.getSettings = getSettings;
        this.logger = logger;
        this.clock = clock;
        this.onClearDaemon = onClearDaemon;
        this.onCloseDaemonLog = onCloseDaemonLog;
    }

    policy() {
        const settings = this.getSettings() || {};
        return {
            retentionDays: numberOr(settings.logRetentionDays,
                DEFAULT_LOG_POLICY.retentionDays),
            maxTotalBytes: numberOr(settings.maxLogTotalBytes,
                DEFAULT_LOG_POLICY.maxTotalBytes),
            protectModifiedWithinMs: DEFAULT_LOG_POLICY.protectModifiedWithinMs,
        };
    }

    _entries() {
        return this.store.list().filter(entry => AREAS.has(entry.area));
    }

    info() {
        const entries = this._entries();
        return {
            ...summarizeLogEntries(entries),
            policy: this.policy(),
        };
    }

    prune() {
        const entries = this._entries();
        const policy = this.policy();
        const plan = planLogCleanup(entries, {
            nowMs: this.clock.nowMs(),
            ...policy,
        });
        const removed = this.store.remove(plan.deleted);
        const result = {
            deleted: removed.deleted,
            bytesFreed: removed.bytesFreed,
            remaining: summarizeLogEntries(this._entries()),
        };
        this.logger?.info('Log cleanup completed', {
            deleted: result.deleted,
            bytesFreed: result.bytesFreed,
        });
        return result;
    }

    clear(scope = 'run-logs') {
        const normalized = String(scope || '').trim();
        if (!SCOPES.has(normalized))
            throw new Error(`Invalid log scope: ${normalized}`);
        const includeDaemon = normalized === 'all' || normalized === 'daemon';
        const includeRuns = normalized === 'all' || normalized === 'runs' ||
            normalized === 'run-logs';
        if (includeDaemon)
            this.onClearDaemon?.();
        const entries = this._entries().filter(entry =>
            (includeDaemon && entry.area === 'daemon') ||
            (includeRuns && entry.area === 'jobs'));
        const removed = this.store.remove(entries);
        const result = {
            scope: normalized,
            deleted: removed.deleted,
            bytesFreed: removed.bytesFreed,
            remaining: summarizeLogEntries(this._entries()),
        };
        this.logger?.info('Logs cleared', {
            scope: normalized,
            deleted: result.deleted,
            bytesFreed: result.bytesFreed,
        });
        return result;
    }

    sanitize() {
        const policy = this.policy();
        const cutoff = this.clock.nowMs() - policy.protectModifiedWithinMs;
        const entries = this._entries();
        const safe = entries.filter(entry => entry.area === 'daemon' ||
            Number(entry.mtimeMs || 0) < cutoff);
        if (safe.some(entry => entry.area === 'daemon'))
            this.onCloseDaemonLog?.();
        const result = this.store.sanitize(safe);
        const sanitized = {
            ...result,
            skipped: entries.length - safe.length,
        };
        this.logger?.info('Logs sanitized', sanitized);
        return sanitized;
    }
}
