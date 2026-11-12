import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {ensureDir, nowIso} from './util.js';

const LEVELS = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

export class Logger {
    constructor({name = 'saveme', filePath = null, level = 'info', echo = true} = {}) {
        this.name = name;
        this.filePath = filePath;
        this.level = level;
        this.echo = echo;
        this._stream = null;
        this._data = null;
    }

    setFilePath(path) {
        this.close();
        this.filePath = path;
    }

    _openFile() {
        if (this._stream || !this.filePath)
            return;
        ensureDir(GLib.path_get_dirname(this.filePath), 0o700);
        const file = Gio.File.new_for_path(this.filePath);
        this._stream = file.append_to(Gio.FileCreateFlags.NONE, null);
        this._data = Gio.DataOutputStream.new(this._stream);
        try {
            file.set_attribute_uint32('unix::mode', 0o600,
                Gio.FileQueryInfoFlags.NONE, null);
        } catch (_) {
            // Best effort.
        }
    }

    _write(level, message, fields = null) {
        if (LEVELS[level] < LEVELS[this.level])
            return;
        let line = `${nowIso()} ${level.toUpperCase()} [${this.name}] ${message}`;
        if (fields && Object.keys(fields).length > 0)
            line += ` ${JSON.stringify(fields)}`;
        if (this.echo)
            printerr(line);
        if (this.filePath) {
            try {
                this._openFile();
                this._data.put_string(`${line}\n`, null);
                this._data.flush(null);
            } catch (e) {
                printerr(`saveme logger error: ${e.message}`);
            }
        }
    }

    debug(message, fields = null) {
        this._write('debug', message, fields);
    }

    info(message, fields = null) {
        this._write('info', message, fields);
    }

    warn(message, fields = null) {
        this._write('warn', message, fields);
    }

    error(message, fields = null) {
        this._write('error', message, fields);
    }

    child(name, filePath = null) {
        return new Logger({
            name: `${this.name}/${name}`,
            filePath: filePath ?? this.filePath,
            level: this.level,
            echo: this.echo,
        });
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

export function appendText(path, text) {
    ensureDir(GLib.path_get_dirname(path), 0o700);
    const file = Gio.File.new_for_path(path);
    const stream = file.append_to(Gio.FileCreateFlags.NONE, null);
    try {
        file.set_attribute_uint32('unix::mode', 0o600,
            Gio.FileQueryInfoFlags.NONE, null);
    } catch (_) {
        // Best effort.
    }
    const data = Gio.DataOutputStream.new(stream);
    data.put_string(text, null);
    data.flush(null);
    data.close(null);
    stream.close(null);
}

export function readTextTail(path, maxLines = 400) {
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return '';
    const [, bytes] = file.load_contents(null);
    const lines = new TextDecoder().decode(bytes).split('\n');
    return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
}
