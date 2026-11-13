import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {ensureDir} from '../../util.js';

export class GioRawLog {
    constructor(path) {
        this.path = path;
        ensureDir(GLib.path_get_dirname(path), 0o700);
        const file = Gio.File.new_for_path(path);
        this._stream = file.append_to(Gio.FileCreateFlags.NONE, null);
        try {
            file.set_attribute_uint32('unix::mode', 0o600,
                Gio.FileQueryInfoFlags.NONE, null);
        } catch (_) {
            // Best effort.
        }
        this._data = Gio.DataOutputStream.new(this._stream);
    }

    write(line) {
        try {
            this._data.put_string(`${line}\n`, null);
        } catch (_) {
            // Ignore log write failures.
        }
    }

    close() {
        try {
            this._data.flush(null);
            this._data.close(null);
            this._stream.close(null);
        } catch (_) {
            // Ignore.
        }
    }
}

export class GioRawLogFactory {
    create(path) {
        return new GioRawLog(path);
    }
}
