import Gio from 'gi://Gio';
import {sanitizeLogText} from './domain/log-policy.js';
import {nowIso} from './util.js';
import {RotatingFile} from './adapters/system/rotating-file.js';

const LEVELS = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

export class Logger {
    constructor({
        name = 'saveme',
        filePath = null,
        level = 'info',
        echo = true,
        maxBytes = 4 * 1024 * 1024,
        maxFiles = 1,
    } = {}) {
        this.name = name;
        this.filePath = filePath;
        this.level = level;
        this.echo = echo;
        this.maxBytes = maxBytes;
        this.maxFiles = maxFiles;
        this._file = new RotatingFile({
            path: filePath,
            maxBytes,
            maxFiles,
        });
    }

    setFilePath(path) {
        this.filePath = path;
        this._file.setPath(path);
    }

    _write(level, message, fields = null) {
        if (LEVELS[level] < LEVELS[this.level])
            return;
        let line = `${nowIso()} ${level.toUpperCase()} [${this.name}] ${message}`;
        if (fields && Object.keys(fields).length > 0)
            line += ` ${JSON.stringify(fields)}`;
        line = sanitizeLogText(line);
        if (this.echo)
            printerr(line);
        if (this.filePath) {
            try {
                this._file.write(`${line}\n`);
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
            maxBytes: this.maxBytes,
            maxFiles: this.maxFiles,
        });
    }

    clear({removeBackups = true} = {}) {
        this._file.clear({removeBackups});
    }

    close() {
        this._file.close();
    }
}

export function readTextTail(path, maxLines = 400) {
    const file = Gio.File.new_for_path(path);
    if (!file.query_exists(null))
        return '';
    const [, bytes] = file.load_contents(null);
    const lines = new TextDecoder().decode(bytes).split('\n');
    return sanitizeLogText(
        lines.slice(Math.max(0, lines.length - maxLines)).join('\n'));
}
