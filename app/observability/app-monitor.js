import GLib from 'gi://GLib';
import {cpuPercent, readProcessMetrics} from './process-metrics.js';

const MIB = 1024 * 1024;

export const DEFAULT_MONITOR_LIMITS = Object.freeze({
    memoryWarnBytes: 256 * MIB,
    growthWarnBytes: 64 * MIB,
    cpuWarnPercent: 80,
});

function defaultSetTimeout(callback, delayMs) {
    return GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(0, delayMs), () => {
        callback();
        return GLib.SOURCE_REMOVE;
    });
}

function defaultClearTimeout(id) {
    if (id)
        GLib.source_remove(id);
}

export class AppMonitor {
    constructor({
        reader = readProcessMetrics,
        logger = null,
        intervalMs = 60_000,
        limits = DEFAULT_MONITOR_LIMITS,
        setTimeout = defaultSetTimeout,
        clearTimeout = defaultClearTimeout,
    } = {}) {
        this.reader = reader;
        this.logger = logger;
        this.intervalMs = Math.max(1000, Number(intervalMs) || 60_000);
        this.limits = {...DEFAULT_MONITOR_LIMITS, ...limits};
        this.setTimeout = setTimeout;
        this.clearTimeout = clearTimeout;
        this.listeners = new Set();
        this._timer = null;
        this._started = false;
        this._last = null;
        this._lastMetrics = null;
        this._baselineRss = null;
        this._peakRss = 0;
        this._samples = 0;
    }

    onSample(callback) {
        this.listeners.add(callback);
        return () => this.listeners.delete(callback);
    }

    start() {
        if (this._started)
            return;
        this._started = true;
        this.sampleNow('start');
        this._schedule();
    }

    stop() {
        this._started = false;
        this.clearTimeout(this._timer);
        this._timer = null;
    }

    _schedule() {
        if (!this._started || this._timer)
            return;
        this._timer = this.setTimeout(() => {
            this._timer = null;
            this.sampleNow('periodic');
            this._schedule();
        }, this.intervalMs);
    }

    sampleNow(reason = 'manual') {
        let current;
        try {
            current = this.reader();
        } catch (e) {
            this.logger?.warn(`Performance sample failed: ${e.message}`);
            return null;
        }
        if (!current) {
            this.logger?.warn('Performance metrics are unavailable');
            return null;
        }
        if (this._baselineRss === null)
            this._baselineRss = current.rssBytes;
        this._peakRss = Math.max(this._peakRss,
            Number(current.peakRssBytes) || Number(current.rssBytes) || 0);
        const cpu = cpuPercent(this._last, current);
        const growthBytes = Math.max(0,
            Number(current.rssBytes || 0) - this._baselineRss);
        const budgetExceeded =
            Number(current.rssBytes || 0) > this.limits.memoryWarnBytes ||
            growthBytes > this.limits.growthWarnBytes ||
            cpu > this.limits.cpuWarnPercent;
        const metrics = {
            reason,
            sampledAt: new Date(Number(current.sampledAtMs) || Date.now()).toISOString(),
            rssBytes: Number(current.rssBytes) || 0,
            peakRssBytes: this._peakRss,
            growthBytes,
            cpuPercent: cpu,
            samples: ++this._samples,
            budgetExceeded,
        };
        this._last = current;
        this._lastMetrics = metrics;
        this.logger?.info('Performance sample', {
            reason,
            rssMiB: Number((metrics.rssBytes / MIB).toFixed(1)),
            peakMiB: Number((metrics.peakRssBytes / MIB).toFixed(1)),
            growthMiB: Number((metrics.growthBytes / MIB).toFixed(1)),
            cpuPercent: Number(metrics.cpuPercent.toFixed(1)),
            samples: metrics.samples,
        });
        if (budgetExceeded) {
            this.logger?.warn('Performance budget exceeded', {
                rssMiB: Number((metrics.rssBytes / MIB).toFixed(1)),
                growthMiB: Number((metrics.growthBytes / MIB).toFixed(1)),
                cpuPercent: Number(metrics.cpuPercent.toFixed(1)),
                memoryLimitMiB: Number((this.limits.memoryWarnBytes / MIB).toFixed(1)),
                growthLimitMiB: Number((this.limits.growthWarnBytes / MIB).toFixed(1)),
                cpuLimitPercent: this.limits.cpuWarnPercent,
            });
        }
        for (const listener of this.listeners) {
            try {
                listener(metrics);
            } catch (e) {
                this.logger?.warn(`Performance listener failed: ${e.message}`);
            }
        }
        return metrics;
    }

    snapshot() {
        return this._lastMetrics;
    }
}
