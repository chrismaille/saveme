import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {sanitizeLogText} from '../../domain/log-policy.js';
import {atomicWriteText} from '../../util.js';
import {appLogFile, daemonLogFile, logsDir, stateDir} from '../../paths.js';

const MAX_SANITIZE_BYTES = 20 * 1024 * 1024;

function infoFor(file) {
    try {
        const info = file.query_info(
            'standard::size,standard::type,time::modified',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        if (info.get_file_type() !== Gio.FileType.REGULAR)
            return null;
        return {
            size: info.get_size(),
            mtimeMs: Number(info.get_attribute_uint64('time::modified')) * 1000,
        };
    } catch (_) {
        return null;
    }
}

function areaFor(path, {statePath, logsPath, daemonPath, appPath}) {
    if (path === daemonPath || path.startsWith(`${daemonPath}.`))
        return 'daemon';
    if (path === appPath || path.startsWith(`${appPath}.`))
        return 'app';
    if (path.startsWith(`${logsPath}/`))
        return 'jobs';
    if (path.startsWith(statePath))
        return 'state';
    return 'other';
}

function runIds(path, logsPath) {
    const relative = path.slice(logsPath.length + 1).split('/');
    const jobId = relative.length > 1 ? relative[0] : null;
    const name = relative[relative.length - 1]
        .replace(/\.rclone\.jsonl(?:\.\d+)?$/, '')
        .replace(/\.log(?:\.\d+)?$/, '');
    return {jobId, runId: name};
}

export class LogStore {
    constructor({
        statePath = stateDir(),
        logsPath = logsDir(),
        daemonPath = daemonLogFile(),
        appPath = appLogFile(),
        maxSanitizeBytes = MAX_SANITIZE_BYTES,
    } = {}) {
        this.statePath = statePath;
        this.logsPath = logsPath;
        this.daemonPath = daemonPath;
        this.appPath = appPath;
        this.maxSanitizeBytes = maxSanitizeBytes;
    }

    _entry(path, info) {
        const area = areaFor(path, this);
        const run = area === 'jobs' ? runIds(path, this.logsPath) : {jobId: null, runId: null};
        return {
            path,
            area,
            jobId: run.jobId,
            runId: run.runId,
            kind: path.endsWith('.rclone.jsonl') || /\.jsonl(?:\.\d+)?$/.test(path)
                ? 'raw'
                : 'text',
            size: info.size,
            mtimeMs: info.mtimeMs,
        };
    }

    _walk(directory, entries) {
        let enumerator;
        try {
            enumerator = Gio.File.new_for_path(directory).enumerate_children(
                'standard::name,standard::type,standard::size,time::modified',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        } catch (_) {
            return;
        }
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const path = GLib.build_filenamev([directory, info.get_name()]);
            if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                this._walk(path, entries);
                continue;
            }
            if (info.get_file_type() !== Gio.FileType.REGULAR)
                continue;
            entries.push(this._entry(path, {
                size: info.get_size(),
                mtimeMs: Number(info.get_attribute_uint64('time::modified')) * 1000,
            }));
        }
        enumerator.close(null);
    }

    list() {
        const entries = [];
        const daemon = Gio.File.new_for_path(this.daemonPath);
        const daemonInfo = infoFor(daemon);
        if (daemonInfo)
            entries.push(this._entry(this.daemonPath, daemonInfo));
        this._walk(this.logsPath, entries);
        const seen = new Set(entries.map(entry => entry.path));
        const directory = Gio.File.new_for_path(GLib.path_get_dirname(this.daemonPath));
        try {
            const enumerator = directory.enumerate_children(
                'standard::name,standard::type,standard::size,time::modified',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                if (name !== GLib.path_get_basename(this.daemonPath) &&
                    !name.startsWith(`${GLib.path_get_basename(this.daemonPath)}.`))
                    continue;
                if (info.get_file_type() !== Gio.FileType.REGULAR)
                    continue;
                const path = GLib.build_filenamev([GLib.path_get_dirname(this.daemonPath), name]);
                if (seen.has(path))
                    continue;
                entries.push(this._entry(path, {
                    size: info.get_size(),
                    mtimeMs: Number(info.get_attribute_uint64('time::modified')) * 1000,
                }));
            }
            enumerator.close(null);
        } catch (_) {
            // Missing daemon log directory is fine.
        }
        entries.sort((a, b) => String(a.path).localeCompare(String(b.path)));
        return entries;
    }

    remove(entries) {
        let deleted = 0;
        let bytesFreed = 0;
        for (const entry of entries) {
            const file = Gio.File.new_for_path(entry.path);
            if (!file.query_exists(null))
                continue;
            try {
                file.delete(null);
                deleted++;
                bytesFreed += Math.max(0, Number(entry.size) || 0);
            } catch (_) {
                // Best effort; a busy file is reported in the next inventory.
            }
        }
        return {deleted, bytesFreed};
    }

    sanitize(entries) {
        let files = 0;
        let changed = 0;
        let bytes = 0;
        for (const entry of entries) {
            if (entry.size > this.maxSanitizeBytes)
                continue;
            try {
                const [ok, raw] = GLib.file_get_contents(entry.path);
                if (!ok)
                    continue;
                files++;
                bytes += raw.length;
                const text = new TextDecoder().decode(raw);
                const clean = sanitizeLogText(text);
                if (clean !== text) {
                    atomicWriteText(entry.path, clean, 0o600);
                    changed++;
                }
            } catch (_) {
                // Skip unreadable files.
            }
        }
        return {files, changed, bytes};
    }
}
