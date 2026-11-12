import GLib from 'gi://GLib';

function isUnder(path, parent) {
    return path === parent || path.startsWith(`${parent}/`);
}

export class ChangeQueue {
    constructor({debounceMs = 1000, maxBatchMs = 2000, onFlush, logger = null} = {}) {
        this.debounceMs = debounceMs;
        this.maxBatchMs = maxBatchMs;
        this.onFlush = onFlush;
        this.logger = logger;
        this._changes = new Map();
        this._timer = null;
        this._firstAt = 0;
        this._draining = false;
    }

    add(path, kind) {
        if (!path || !kind)
            return;
        const coverage = this._findDirChangeCovering(path);
        if (coverage) {
            if (coverage.kind === 'dir-delete' && kind !== 'delete' && kind !== 'dir-delete') {
                this._changes.delete(coverage.path);
                this._changes.set(coverage.path, 'dir-upsert');
                this._schedule();
                return;
            }
            if (coverage.kind === 'dir-delete')
                return;
            // A queued dir-upsert does not cover later events: the directory
            // copy may happen before the child is written. Keep the child.
        }
        if (kind === 'dir-upsert' || kind === 'dir-delete')
            this._removeUnder(path);
        const existing = this._changes.get(path);
        if (!existing) {
            this._changes.set(path, kind);
        } else {
            this._changes.set(path, this._coalesce(existing, kind));
        }
        this._schedule();
    }

    _coalesce(existing, next) {
        if (existing === next)
            return existing;
        if (existing === 'upsert' && next === 'delete')
            return 'delete';
        if (existing === 'delete' && next === 'upsert')
            return 'upsert';
        if (existing === 'dir-upsert' && next === 'dir-delete')
            return 'dir-delete';
        if (existing === 'dir-delete' && next === 'dir-upsert')
            return 'dir-upsert';
        if (existing === 'dir-upsert')
            return 'dir-upsert';
        if (next === 'dir-upsert')
            return 'dir-upsert';
        return next;
    }

    _findDirChangeCovering(path) {
        for (const [changedPath, kind] of this._changes) {
            if ((kind === 'dir-upsert' || kind === 'dir-delete') &&
                isUnder(path, changedPath))
                return {path: changedPath, kind};
        }
        return null;
    }

    _removeUnder(path) {
        for (const changedPath of [...this._changes.keys()]) {
            if (changedPath !== path && isUnder(changedPath, path))
                this._changes.delete(changedPath);
        }
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
        if (this._changes.size === 0)
            return;
        this._draining = true;
        const changes = [...this._changes.entries()]
            .map(([path, kind]) => ({path, kind}));
        this._changes.clear();
        this._firstAt = 0;
        try {
            await this.onFlush?.(changes);
        } catch (e) {
            this.logger?.error(`Change batch failed: ${e.message}`);
        } finally {
            this._draining = false;
            if (this._changes.size > 0)
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
        this._changes.clear();
        this._firstAt = 0;
    }

    get size() {
        return this._changes.size;
    }
}
