import Gio from 'gi://Gio';
import {canonicalPath, isPathInside, joinPath} from './util.js';
import {VolumeUnavailableError} from './domain/errors.js';

export {VolumeUnavailableError};

export class VolumeResolver {
    constructor() {
        this._monitor = Gio.VolumeMonitor.get();
        this._mounts = [];
        this._handlers = [];
        this.refresh();
    }

    refresh() {
        this._mounts = [];
        for (const mount of this._monitor.get_mounts()) {
            const root = mount.get_root();
            const mountPoint = root?.get_path();
            if (!mountPoint || !mountPoint.startsWith('/'))
                continue;
            const volume = mount.get_volume();
            const uuid = volume?.get_identifier('uuid') ?? null;
            if (!uuid)
                continue;
            this._mounts.push({
                uuid,
                name: volume.get_name() || uuid,
                mountPoint: canonicalPath(mountPoint),
            });
        }
        this._mounts.sort((a, b) => b.mountPoint.length - a.mountPoint.length);
        return this._mounts;
    }

    list() {
        this.refresh();
        return this._mounts.map(mount => ({...mount}));
    }

    findForPath(path) {
        this.refresh();
        const canonical = canonicalPath(path);
        for (const mount of this._mounts) {
            if (canonical === mount.mountPoint || isPathInside(mount.mountPoint, canonical)) {
                const relative = canonical === mount.mountPoint
                    ? ''
                    : canonical.slice(mount.mountPoint.length + 1);
                return {
                    volumeUuid: mount.uuid,
                    volumeName: mount.name,
                    mountPoint: mount.mountPoint,
                    relativePath: relative,
                };
            }
        }
        return null;
    }

    makeDescriptor(path) {
        const canonical = canonicalPath(path);
        const match = this.findForPath(canonical);
        if (!match)
            return {kind: 'local', path: canonical};
        return {
            kind: 'local',
            path: canonical,
            volumeUuid: match.volumeUuid,
            volumeName: match.volumeName,
            relativePath: match.relativePath,
        };
    }

    resolve(descriptor) {
        if (descriptor.kind !== 'local')
            throw new Error('resolve() expects a local descriptor');
        if (!descriptor.volumeUuid)
            return canonicalPath(descriptor.path);
        this.refresh();
        const mount = this._mounts.find(item => item.uuid === descriptor.volumeUuid);
        if (!mount)
            throw new VolumeUnavailableError(descriptor);
        return joinPath(mount.mountPoint, descriptor.relativePath || '');
    }

    isAvailable(descriptor) {
        try {
            this.resolve(descriptor);
            return true;
        } catch (_) {
            return false;
        }
    }

    volumeName(uuid) {
        if (!uuid)
            return null;
        const volume = this._monitor.get_volumes()
            .find(item => item.get_identifier('uuid') === uuid);
        return volume?.get_name() ?? null;
    }

    connect(callback) {
        for (const signal of ['mount-added', 'mount-removed', 'drive-connected', 'drive-disconnected']) {
            const id = this._monitor.connect(signal, () => {
                this.refresh();
                callback(signal);
            });
            this._handlers.push({signal, id});
        }
    }

    disconnect() {
        for (const {id} of this._handlers)
            this._monitor.disconnect(id);
        this._handlers = [];
    }
}
