import GLib from 'gi://GLib';
import {ChangeBatcher} from './domain/change-batcher.js';

export class ChangeQueue {
    constructor({debounceMs = 1000, maxBatchMs = 2000, onFlush, logger = null} = {}) {
        this.debounceMs = debounceMs;
        this.maxBatchMs = maxBatchMs;
        this.onFlush = onFlush;
        this.logger = logger;
        this._batcher = new ChangeBatcher();
        this._timer = null;
        this._firstAt = 0;
        this._draining = false;
    }

    add(path, kind) {
        if (this._batcher.add(path, kind))
            this._schedule();
    }

    _schedule() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        if (this._firstAt === 0)
            this._firstAt = Date.now();
        const elapsed = Date.now() - this._firstAt;
        const delay = Math.max(0, Math.min(this.debounceMs, this.maxBatchMs - elapsed));
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._timer = null;
            this._drain();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _drain() {
        if (this._draining) {
            this._schedule();
            return;
        }
        if (this._batcher.size === 0)
            return;
        this._draining = true;
        const changes = this._batcher.drain();
        this._firstAt = 0;
        try {
            await this.onFlush?.(changes);
        } catch (e) {
            this.logger?.error(`Change batch failed: ${e.message}`);
        } finally {
            this._draining = false;
            if (this._batcher.size > 0)
                this._schedule();
        }
    }

    async flushNow() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        await this._drain();
    }

    stop() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        this._batcher.clear();
        this._firstAt = 0;
    }

    get size() {
        return this._batcher.size;
    }
}
