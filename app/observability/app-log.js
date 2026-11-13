import Gio from 'gi://Gio';
import {Logger, readTextTail} from '../../src/log.js';
import {appLogFile} from '../../src/paths.js';
import {sanitizeLogText} from '../../src/domain/log-policy.js';
import {atomicWriteText} from '../../src/util.js';

export class AppLog {
    constructor({
        path = appLogFile(),
        name = 'app',
        maxBytes = 2 * 1024 * 1024,
        maxFiles = 2,
        echo = false,
    } = {}) {
        this.path = path;
        this.maxBytes = maxBytes;
        this.maxFiles = maxFiles;
        this.logger = new Logger({
            name,
            filePath: path,
            echo,
            maxBytes,
            maxFiles,
        });
    }

    info() {
        let totalBytes = 0;
        let files = 0;
        for (let index = 0; index <= this.maxFiles; index++) {
            const path = index === 0 ? this.path : `${this.path}.${index}`;
            const file = Gio.File.new_for_path(path);
            if (!file.query_exists(null))
                continue;
            try {
                totalBytes += file.query_info('standard::size',
                    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null).get_size();
                files++;
            } catch (_) {
                // Ignore unreadable rotated logs.
            }
        }
        return {
            path: this.path,
            files,
            totalBytes,
            maxBytes: this.maxBytes,
        };
    }

    readTail(maxLines = 800) {
        return readTextTail(this.path, maxLines);
    }

    sanitize() {
        this.logger.close();
        let files = 0;
        let changed = 0;
        let bytes = 0;
        for (let index = 0; index <= this.maxFiles; index++) {
            const path = index === 0 ? this.path : `${this.path}.${index}`;
            const file = Gio.File.new_for_path(path);
            if (!file.query_exists(null))
                continue;
            try {
                const [, raw] = file.load_contents(null);
                files++;
                bytes += raw.length;
                const text = new TextDecoder().decode(raw);
                const clean = sanitizeLogText(text);
                if (clean !== text) {
                    atomicWriteText(path, clean, 0o600);
                    changed++;
                }
            } catch (_) {
                // Skip unreadable files.
            }
        }
        return {files, changed, bytes};
    }

    clear() {
        this.logger.clear();
    }

    close() {
        this.logger.close();
    }
}
