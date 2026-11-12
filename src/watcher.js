import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {basename, canonicalPath, dirname} from './util.js';

export class WatcherLimitError extends Error {
    constructor(limit, count) {
        super(`inotify watch limit reached (${count}/${limit})`);
        this.name = 'WatcherLimitError';
        this.limit = limit;
        this.count = count;
    }
}

export function getInotifyLimit() {
    try {
        const [, bytes] = GLib.file_get_contents('/proc/sys/fs/inotify/max_user_watches');
        const value = Number(new TextDecoder().decode(bytes).trim());
        return Number.isFinite(value) && value > 0 ? value : 8192;
    } catch (_) {
        return 8192;
    }
}

const DEFAULT_IGNORES = [
    '.goutputstream-*',
    '.~*',
    '*.tmp',
    '*.partial',
    '*.swp',
    '*.swx',
    '~$*',
    '.DS_Store',
    'Thumbs.db',
    'desktop.ini',
];

export class RecursiveWatcher {
    constructor({
        rootPath,
        onChange,
        onUnavailable = null,
        onError = null,
        logger = null,
        maxWatches = null,
        ignore = [],
    }) {
        this.rootPath = canonicalPath(rootPath);
        this.onChange = onChange;
        this.onUnavailable = onUnavailable;
        this.onError = onError;
        this.logger = logger;
        this.maxWatches = maxWatches || getInotifyLimit();
        this.ignore = [...DEFAULT_IGNORES, ...ignore];
        this._monitors = new Map();
        this._stopped = false;
    }

    get watchCount() {
        return this._monitors.size;
    }

    async start() {
        const root = Gio.File.new_for_path(this.rootPath);
        if (!root.query_exists(null))
            throw new Error(`Source directory does not exist: ${this.rootPath}`);
        const type = root.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        if (type !== Gio.FileType.DIRECTORY)
            throw new Error(`Source is not a directory: ${this.rootPath}`);
        await this._addTree(this.rootPath);
        this.logger?.info(`Watching ${this._monitors.size} directories under ${this.rootPath}`);
    }

    async _addTree(dirPath) {
        if (this._stopped || this._monitors.has(dirPath))
            return;
        if (this._monitors.size + 1 > Math.floor(this.maxWatches * 0.8))
            throw new WatcherLimitError(this.maxWatches, this._monitors.size + 1);

        const dir = Gio.File.new_for_path(dirPath);
        let monitor;
        try {
            monitor = dir.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
        } catch (e) {
            this.logger?.warn(`Cannot monitor ${dirPath}: ${e.message}`);
            return;
        }
        monitor.connect('changed', (_monitor, file, otherFile, eventType) => {
            this._onChanged(file, otherFile, eventType);
        });
        this._monitors.set(dirPath, monitor);

        let dirs;
        try {
            dirs = await this._listSubdirectories(dirPath);
        } catch (e) {
            this.logger?.debug(`Cannot enumerate ${dirPath}: ${e.message}`);
            return;
        }
        for (const name of dirs) {
            if (this._stopped)
                return;
            await this._addTree(GLib.build_filenamev([dirPath, name]));
        }
    }

    _listSubdirectories(dirPath) {
        return new Promise((resolve, reject) => {
            const dir = Gio.File.new_for_path(dirPath);
            dir.enumerate_children_async(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                GLib.PRIORITY_DEFAULT,
                null,
                (source, result) => {
                    let enumerator;
                    try {
                        enumerator = source.enumerate_children_finish(result);
                    } catch (e) {
                        reject(e);
                        return;
                    }
                    const names = [];
                    const readBatch = () => {
                        enumerator.next_files_async(100, GLib.PRIORITY_DEFAULT, null,
                            (src, res) => {
                                let infos;
                                try {
                                    infos = src.next_files_finish(res);
                                } catch (e) {
                                    enumerator.close(null);
                                    reject(e);
                                    return;
                                }
                                if (infos.length === 0) {
                                    enumerator.close(null);
                                    resolve(names);
                                    return;
                                }
                                for (const info of infos) {
                                    if (info.get_file_type() === Gio.FileType.DIRECTORY)
                                        names.push(info.get_name());
                                }
                                readBatch();
                            });
                    };
                    readBatch();
                });
        });
    }

    _onChanged(file, otherFile, eventType) {
        if (this._stopped)
            return;
        const path = file?.get_path() ?? null;
        const otherPath = otherFile?.get_path() ?? null;

        switch (eventType) {
        case Gio.FileMonitorEvent.CHANGES_DONE_HINT:
            if (path)
                this._emitPath(path);
            break;
        case Gio.FileMonitorEvent.CHANGED:
            // CHANGES_DONE_HINT is the reliable signal for completed writes.
            break;
        case Gio.FileMonitorEvent.CREATED:
        case Gio.FileMonitorEvent.MOVED_IN:
            if (path)
                this._handleCreated(path);
            break;
        case Gio.FileMonitorEvent.DELETED:
        case Gio.FileMonitorEvent.MOVED_OUT:
            if (path)
                this._handleDeleted(path);
            break;
        case Gio.FileMonitorEvent.RENAMED:
            if (path && !this._shouldIgnore(path)) {
                if (this._monitors.has(path)) {
                    this._removeMonitorsUnder(path);
                    this.onChange?.({path, kind: 'dir-delete'});
                } else {
                    this.onChange?.({path, kind: 'delete'});
                }
            }
            if (otherPath && !this._shouldIgnore(otherPath)) {
                this._handleCreated(otherPath);
            }
            break;
        case Gio.FileMonitorEvent.ATTRIBUTE_CHANGED:
            if (path)
                this._emitPath(path);
            break;
        default:
            break;
        }
    }

    _handleCreated(path) {
        const file = Gio.File.new_for_path(path);
        let type;
        try {
            type = file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        } catch (_) {
            return;
        }
        if (type === Gio.FileType.DIRECTORY) {
            this.onChange?.({path, kind: 'dir-upsert'});
            this._addTree(path).catch(e => {
                if (e instanceof WatcherLimitError)
                    this.onError?.(e);
                else
                    this.logger?.warn(`Cannot add monitor for ${path}: ${e.message}`);
            });
        } else if (type === Gio.FileType.REGULAR) {
            this.onChange?.({path, kind: 'upsert'});
        }
    }

    _handleDeleted(path) {
        const wasDirectory = this._monitors.has(path);
        if (wasDirectory)
            this._removeMonitorsUnder(path);
        if (path === this.rootPath) {
            this.onUnavailable?.();
            return;
        }
        this.onChange?.({path, kind: wasDirectory ? 'dir-delete' : 'delete'});
    }

    _emitPath(path) {
        if (this._shouldIgnore(path))
            return;
        const file = Gio.File.new_for_path(path);
        let type;
        try {
            type = file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        } catch (_) {
            return;
        }
        if (type === Gio.FileType.DIRECTORY)
            this.onChange?.({path, kind: 'dir-upsert'});
        else if (type === Gio.FileType.REGULAR)
            this.onChange?.({path, kind: 'upsert'});
    }

    _shouldIgnore(path) {
        const name = basename(path);
        if (name === '.saveme' || name === '.saveme-versions')
            return true;
        for (const pattern of this.ignore) {
            if (GLib.pattern_match_simple(pattern, name))
                return true;
        }
        // GLib/GIO atomic writes use "name.XXXXXX" temporary files. If the
        // original name exists, this is almost certainly a temporary file.
        const tempMatch = name.match(/^(.+)\.[A-Za-z0-9]{6}$/);
        if (tempMatch) {
            const original = GLib.build_filenamev([dirname(path), tempMatch[1]]);
            if (GLib.file_test(original, GLib.FileTest.EXISTS))
                return true;
        }
        return false;
    }

    _removeMonitorsUnder(path) {
        for (const watched of [...this._monitors.keys()]) {
            if (watched === path || watched.startsWith(`${path}/`)) {
                const monitor = this._monitors.get(watched);
                try {
                    monitor.cancel();
                } catch (_) {
                    // Ignore.
                }
                this._monitors.delete(watched);
            }
        }
    }

    stop() {
        this._stopped = true;
        for (const monitor of this._monitors.values()) {
            try {
                monitor.cancel();
            } catch (_) {
                // Ignore.
            }
        }
        this._monitors.clear();
    }
}
