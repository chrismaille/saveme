import Gio from 'gi://Gio';
import {
    atomicWriteText,
    ensureDir,
    joinPath,
    relativePath,
} from '../../util.js';

export class GioFileSystem {
    exists(path) {
        return Gio.File.new_for_path(path).query_exists(null);
    }

    queryType(path) {
        const file = Gio.File.new_for_path(path);
        if (!file.query_exists(null))
            return null;
        try {
            const type = file.query_file_type(
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            if (type === Gio.FileType.DIRECTORY)
                return 'directory';
            if (type === Gio.FileType.REGULAR)
                return 'file';
            return 'other';
        } catch (_) {
            return null;
        }
    }

    isDirectory(path) {
        return this.queryType(path) === 'directory';
    }

    topLevelEntryCount(path, {ignore = []} = {}) {
        const ignored = new Set(ignore);
        const file = Gio.File.new_for_path(path);
        const enumerator = file.enumerate_children('standard::name',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        let count = 0;
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            if (ignored.has(info.get_name()))
                continue;
            count++;
        }
        enumerator.close(null);
        return count;
    }

    relativePath(root, path) {
        return relativePath(root, path);
    }

    joinPath(...parts) {
        return joinPath.apply(null, parts);
    }

    ensureDir(path, mode = 0o700) {
        return ensureDir(path, mode);
    }

    writeText(path, text, mode = 0o600) {
        atomicWriteText(path, text, mode);
    }

    removeIfExists(path) {
        const file = Gio.File.new_for_path(path);
        if (file.query_exists(null))
            file.delete(null);
    }
}
