function isUnder(path, parent) {
    return path === parent || path.startsWith(`${parent}/`);
}

export function coalesceChange(existing, next) {
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

export class ChangeBatcher {
    constructor() {
        this._changes = new Map();
    }

    add(path, kind) {
        if (!path || !kind)
            return false;
        const coverage = this._findDirChangeCovering(path);
        if (coverage) {
            if (coverage.kind === 'dir-delete' && kind !== 'delete' && kind !== 'dir-delete') {
                this._changes.delete(coverage.path);
                this._changes.set(coverage.path, 'dir-upsert');
                return true;
            }
            if (coverage.kind === 'dir-delete')
                return false;
        }
        if (kind === 'dir-upsert' || kind === 'dir-delete')
            this._removeUnder(path);
        const existing = this._changes.get(path);
        this._changes.set(path, existing ? coalesceChange(existing, kind) : kind);
        return true;
    }

    _findDirChangeCovering(path) {
        for (const entry of this._changes) {
            const changedPath = entry[0];
            const kind = entry[1];
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

    drain() {
        const changes = [];
        for (const entry of this._changes) {
            changes.push({path: entry[0], kind: entry[1]});
        }
        this._changes.clear();
        return changes;
    }

    clear() {
        this._changes.clear();
    }

    get size() {
        return this._changes.size;
    }
}
