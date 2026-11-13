import {sanitizeLogText} from '../../domain/log-policy.js';
import {RotatingFile} from '../system/rotating-file.js';

export class GioRawLog {
    constructor(path, {maxBytes = 20 * 1024 * 1024, maxFiles = 1} = {}) {
        this.path = path;
        this._file = new RotatingFile({path, maxBytes, maxFiles});
    }

    write(line) {
        try {
            this._file.write(`${sanitizeLogText(line)}\n`);
        } catch (_) {
            // Ignore log write failures.
        }
    }

    clear() {
        this._file.clear();
    }

    close() {
        this._file.close();
    }
}

export class GioRawLogFactory {
    create(path, options = {}) {
        return new GioRawLog(path, options);
    }
}
