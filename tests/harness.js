import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {removeRecursive} from '../src/util.js';

export function assert(condition, message = 'Assertion failed') {
    if (!condition)
        throw new Error(message);
}

export function assertEqual(actual, expected, message = 'assertEqual') {
    if (actual !== expected) {
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, ` +
            `got ${JSON.stringify(actual)}`);
    }
}

export async function assertThrows(fn, pattern = null, message = 'assertThrows') {
    try {
        await fn();
    } catch (e) {
        if (pattern && !pattern.test(e.message)) {
            throw new Error(`${message}: error message ${JSON.stringify(e.message)} ` +
                `does not match ${pattern}`, {cause: e});
        }
        return e;
    }
    throw new Error(`${message}: expected an error`);
}

export function test(name, fn) {
    return {name, fn};
}

export function suite(name, tests) {
    return {name, tests};
}

export function tempDir(prefix = 'saveme-test') {
    return GLib.dir_make_tmp(`${prefix}-XXXXXX`);
}

export function cleanup(path) {
    try {
        removeRecursive(path);
    } catch (_) {
        // Best effort.
    }
}

export function writeFile(path, content) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
    GLib.file_set_contents(path, content);
}

export function readFile(path) {
    const [ok, bytes] = GLib.file_get_contents(path);
    if (!ok)
        throw new Error(`Cannot read ${path}`);
    return new TextDecoder().decode(bytes);
}

export function findFiles(root) {
    const result = [];
    const walk = (dir, prefix) => {
        const file = Gio.File.new_for_path(dir);
        if (!file.query_exists(null))
            return;
        const enumerator = file.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            const path = GLib.build_filenamev([dir, name]);
            const rel = prefix ? `${prefix}/${name}` : name;
            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                walk(path, rel);
            else
                result.push({path, relative: rel});
        }
        enumerator.close(null);
    };
    walk(root, '');
    return result;
}
