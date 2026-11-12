import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export function expandUser(path) {
    if (!path)
        return path;
    if (path === '~')
        return GLib.get_home_dir();
    if (path.startsWith('~/'))
        return GLib.build_filenamev([GLib.get_home_dir(), path.slice(2)]);
    return path;
}

export function canonicalPath(path) {
    return GLib.canonicalize_filename(expandUser(path), null);
}

export function ensureDir(path, mode = 0o700) {
    if (!path)
        throw new Error('Cannot create an empty directory path');
    if (GLib.mkdir_with_parents(path, mode) !== 0 &&
        !GLib.file_test(path, GLib.FileTest.IS_DIR))
        throw new Error(`Cannot create directory: ${path}`);
    return path;
}

export function isPathInside(parent, child) {
    const p = canonicalPath(parent);
    const c = canonicalPath(child);
    if (p === c)
        return false;
    return c.startsWith(p.endsWith('/') ? p : `${p}/`);
}

export function pathsOverlap(a, b) {
    const ca = canonicalPath(a);
    const cb = canonicalPath(b);
    return ca === cb || isPathInside(ca, cb) || isPathInside(cb, ca);
}

export function relativePath(root, path) {
    const r = canonicalPath(root);
    const p = canonicalPath(path);
    if (p === r)
        return '';
    if (!isPathInside(r, p))
        return null;
    return p.slice(r.endsWith('/') ? r.length : r.length + 1);
}

export function joinPath(...parts) {
    const cleaned = parts.filter(part => part !== undefined && part !== null && part !== '');
    if (cleaned.length === 0)
        return '';
    return GLib.build_filenamev(cleaned);
}

export function readJson(path, fallback = null) {
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return fallback;
    const [, bytes] = file.load_contents(null);
    const text = new TextDecoder().decode(bytes);
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error(`Invalid JSON in ${path}: ${e.message}`);
    }
}

export function readText(path, fallback = null) {
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return fallback;
    const [, bytes] = file.load_contents(null);
    return new TextDecoder().decode(bytes);
}

export function atomicWriteText(path, text, mode = 0o600) {
    ensureDir(GLib.path_get_dirname(path), 0o700);
    const file = Gio.File.new_for_path(path);
    file.replace_contents(text, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    try {
        file.set_attribute_uint32('unix::mode', mode,
            Gio.FileQueryInfoFlags.NONE, null);
    } catch (_) {
        // Best effort: the file is already written.
    }
}

export function atomicWriteJson(path, value, mode = 0o600) {
    atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`, mode);
}

export function copyFile(sourcePath, targetPath) {
    const source = Gio.File.new_for_path(sourcePath);
    const target = Gio.File.new_for_path(targetPath);
    ensureDir(GLib.path_get_dirname(targetPath), 0o700);
    target.replace_contents(source.load_contents(null)[1], null, false,
        Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}

export function removeRecursive(path) {
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return;
    let type;
    try {
        type = file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    } catch (_) {
        return;
    }
    if (type !== Gio.FileType.DIRECTORY) {
        file.delete(null);
        return;
    }
    const enumerator = file.enumerate_children(
        'standard::name,standard::type',
        Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    let info;
    while ((info = enumerator.next_file(null)) !== null)
        removeRecursive(GLib.build_filenamev([path, info.get_name()]));
    enumerator.close(null);
    file.delete(null);
}

export function isExecutable(path) {
    return GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE);
}

export function nowIso() {
    return new Date().toISOString();
}

export function versionTimestamp(date = new Date()) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
        `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function uuid() {
    return GLib.uuid_string_random();
}

export function uniqueId(prefix = '') {
    const random = Math.random().toString(36).slice(2, 8);
    return `${prefix}${Date.now().toString(36)}_${random}`;
}

export function sleep(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

export function humanBytes(value) {
    let n = Number(value) || 0;
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let unit = 0;
    while (n >= 1024 && unit < units.length - 1) {
        n /= 1024;
        unit++;
    }
    return `${n.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(milliseconds) {
    const total = Math.max(0, Math.floor(milliseconds / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours > 0)
        return `${hours}h ${minutes}m`;
    if (minutes > 0)
        return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}

export function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}

export function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function mergeDeep(base, override) {
    const result = deepClone(base);
    if (!isPlainObject(override))
        return result;
    for (const [key, value] of Object.entries(override)) {
        if (isPlainObject(value) && isPlainObject(result[key]))
            result[key] = mergeDeep(result[key], value);
        else
            result[key] = deepClone(value);
    }
    return result;
}

export function toNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

export function toBool(value, fallback = false) {
    if (typeof value === 'boolean')
        return value;
    if (value === 'true' || value === '1' || value === 1)
        return true;
    if (value === 'false' || value === '0' || value === 0)
        return false;
    return fallback;
}

export function basename(path) {
    return GLib.path_get_basename(path);
}

export function dirname(path) {
    return GLib.path_get_dirname(path);
}

export function truncate(value, length = 120) {
    const text = String(value ?? '');
    return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}
