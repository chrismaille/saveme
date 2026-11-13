import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {ensureDir} from '../../util.js';

export class RotatingFile {
    constructor({path = null, maxBytes = 4 * 1024 * 1024, maxFiles = 1, mode = 0o600} = {}) {
        this.path = path;
        this.maxBytes = Math.max(0, Number(maxBytes) || 0);
        this.maxFiles = Math.max(0, Number(maxFiles) || 0);
        this.mode = mode;
        this._stream = null;
        this._data = null;
        this._size = 0;
    }

    setPath(path) {
        this.close();
        this.path = path;
    }

    _open() {
        if (this._stream || !this.path)
            return;
        ensureDir(GLib.path_get_dirname(this.path), 0o700);
        const file = Gio.File.new_for_path(this.path);
        try {
            this._size = file.query_info('standard::size',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null).get_size();
        } catch (_) {
            this._size = 0;
        }
        this._stream = file.append_to(Gio.FileCreateFlags.NONE, null);
        this._data = Gio.DataOutputStream.new(this._stream);
        try {
            file.set_attribute_uint32('unix::mode', this.mode,
                Gio.FileQueryInfoFlags.NONE, null);
        } catch (_) {
            // Best effort.
        }
    }

    _move(source, destination) {
        const sourceFile = Gio.File.new_for_path(source);
        if (!sourceFile.query_exists(null))
            return;
        const destinationFile = Gio.File.new_for_path(destination);
        sourceFile.move(destinationFile, Gio.FileCopyFlags.OVERWRITE, null, null);
    }

    _rotate() {
        this.close();
        if (this.maxFiles <= 0) {
            this._truncateCurrent();
            return;
        }
        for (let index = this.maxFiles; index >= 1; index--) {
            const source = index === 1 ? this.path : `${this.path}.${index - 1}`;
            this._move(source, `${this.path}.${index}`);
        }
    }

    _truncateCurrent() {
        if (!this.path)
            return;
        const file = Gio.File.new_for_path(this.path);
        file.replace_contents('', null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        try {
            file.set_attribute_uint32('unix::mode', this.mode,
                Gio.FileQueryInfoFlags.NONE, null);
        } catch (_) {
            // Best effort.
        }
        this._size = 0;
    }

    write(text) {
        if (!this.path)
            return;
        const value = String(text ?? '');
        if (!value)
            return;
        const bytes = new TextEncoder().encode(value).length;
        this._open();
        if (this.maxBytes > 0 && this._size > 0 &&
            this._size + bytes > this.maxBytes) {
            this._rotate();
            this._open();
        }
        this._data.put_string(value, null);
        this._data.flush(null);
        this._size += bytes;
    }

    clear({removeBackups = true} = {}) {
        this.close();
        this._truncateCurrent();
        if (!removeBackups || !this.path)
            return;
        for (let index = 1; index <= this.maxFiles; index++) {
            const backup = Gio.File.new_for_path(`${this.path}.${index}`);
            if (backup.query_exists(null))
                backup.delete(null);
        }
    }

    close() {
        try {
            this._data?.flush(null);
            this._data?.close(null);
            this._stream?.close(null);
        } catch (_) {
            // Ignore close errors.
        }
        this._data = null;
        this._stream = null;
    }
}
