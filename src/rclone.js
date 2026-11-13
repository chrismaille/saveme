import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {isExecutable, toNumber} from './util.js';
import {bundledRclone, projectRclone} from './paths.js';

export const RCLONE_MIN_VERSION = '1.60.0';

export function findRclone() {
    const candidates = [];
    const fromEnv = GLib.getenv('SAVEME_RCLONE');
    if (fromEnv)
        candidates.push(fromEnv);
    candidates.push(bundledRclone());
    candidates.push(projectRclone());
    const fromPath = GLib.find_program_in_path('rclone');
    if (fromPath)
        candidates.push(fromPath);
    for (const candidate of candidates) {
        if (candidate && isExecutable(candidate))
            return candidate;
    }
    return null;
}

export function isSuccessExit(code) {
    return code === 0 || code === 9;
}

export function exitCodeMessage(code) {
    switch (code) {
    case 0:
        return 'Success';
    case 1:
        return 'Syntax or usage error';
    case 2:
        return 'Error not otherwise categorised';
    case 3:
        return 'Directory not found';
    case 4:
        return 'File not found';
    case 5:
        return 'Temporary error (retries exhausted)';
    case 6:
        return 'Less serious error (some files failed)';
    case 7:
        return 'Fatal error';
    case 8:
        return 'Transfer exceeded maximum duration';
    case 9:
        return 'No files transferred';
    default:
        return `rclone exited with code ${code}`;
    }
}

function emptyStats() {
    return {
        bytes: 0,
        totalBytes: 0,
        transfers: 0,
        totalTransfers: 0,
        checks: 0,
        totalChecks: 0,
        deletes: 0,
        deletedDirs: 0,
        renames: 0,
        errors: 0,
        listed: 0,
        elapsedTime: 0,
        speed: 0,
        eta: null,
        fatalError: false,
        retryError: false,
    };
}

export class Rclone {
    constructor({binary = null, configPath, logger}) {
        this.binary = binary || findRclone();
        if (!this.binary)
            throw new Error('rclone not found. Install rclone or set SAVEME_RCLONE.');
        this.configPath = configPath;
        this.logger = logger;
        this._version = null;
    }

    commonArgs() {
        return [
            '--config', this.configPath,
            '--use-json-log',
            '--stats', '1s',
            '--stats-log-level', 'NOTICE',
            '--log-level', 'INFO',
            '--retries', '3',
            '--low-level-retries', '10',
            '--timeout', '5m',
            '--contimeout', '1m',
        ];
    }

    async run(args, {onLine = null, onStats = null, cancellable = null, timeoutMs = 0} = {}) {
        const argv = [this.binary, ...this.commonArgs(), ...args];
        this.logger?.debug('spawning rclone', {argv});
        const subprocess = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
        const stats = emptyStats();
        let lastStats = null;
        let lastError = null;
        let readError = null;
        let timeoutId = null;
        let forceId = null;

        const cancelProcess = () => {
            try {
                subprocess.send_signal(2); // SIGINT: rclone shuts down gracefully.
            } catch (_) {
                // Process may have already exited.
            }
            if (!forceId) {
                forceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
                    try {
                        subprocess.force_exit();
                    } catch (_) {
                        // Ignore.
                    }
                    forceId = null;
                    return GLib.SOURCE_REMOVE;
                });
            }
        };

        const cancelHandler = cancellable
            ? cancellable.connect(cancelProcess)
            : 0;

        if (timeoutMs > 0) {
            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
                this.logger?.warn('rclone timeout reached; interrupting');
                cancelProcess();
                timeoutId = null;
                return GLib.SOURCE_REMOVE;
            });
        }

        const stream = Gio.DataInputStream.new(subprocess.get_stdout_pipe());

        const readPromise = new Promise(resolve => {
            const readNext = () => {
                stream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (source, res) => {
                    let line = null;
                    try {
                        [line] = source.read_line_finish_utf8(res);
                    } catch (e) {
                        if (!(cancellable?.is_cancelled()))
                            readError = e;
                        resolve();
                        return;
                    }
                    if (line === null) {
                        resolve();
                        return;
                    }
                    this._handleLine(line, stats, parsed => {
                        if (parsed) {
                            if (parsed.stats) {
                                lastStats = parsed.stats;
                                this._mergeStats(stats, parsed.stats);
                                try {
                                    onStats?.(this._publicStats(stats));
                                } catch (e) {
                                    this.logger?.warn(`onStats callback failed: ${e.message}`);
                                }
                            }
                            if (parsed.level === 'error' || parsed.level === 'critical')
                                lastError = parsed.msg || line;
                        } else if (/\b(ERROR|CRITICAL|FATAL)\b/.test(line)) {
                            lastError = line;
                        }
                        try {
                            onLine?.(line, parsed);
                        } catch (e) {
                            this.logger?.warn(`onLine callback failed: ${e.message}`);
                        }
                    });
                    readNext();
                });
            };
            readNext();
        });

        const waitPromise = new Promise(resolve => {
            subprocess.wait_async(null, (proc, res) => {
                try {
                    proc.wait_finish(res);
                } catch (_) {
                    // Cancellation or process teardown.
                }
                resolve();
            });
        });

        await Promise.all([readPromise, waitPromise]);

        if (timeoutId) {
            GLib.source_remove(timeoutId);
        }
        if (forceId) {
            GLib.source_remove(forceId);
        }
        if (cancelHandler)
            cancellable.disconnect(cancelHandler);

        const exitCode = subprocess.get_if_exited() ? subprocess.get_exit_status() : -1;
        if (readError)
            this.logger?.warn(`rclone output read error: ${readError.message}`);

        return {
            exitCode,
            stats: this._publicStats(stats),
            lastStats,
            lastError,
            cancelled: cancellable?.is_cancelled() ?? false,
            argv,
        };
    }

    _handleLine(line, _stats, callback) {
        let parsed = null;
        if (line.startsWith('{')) {
            try {
                parsed = JSON.parse(line);
            } catch (_) {
                parsed = null;
            }
        }
        callback(parsed);
    }

    _mergeStats(target, incoming) {
        for (const [key, value] of Object.entries(incoming)) {
            if (value !== null && value !== undefined && key in target)
                target[key] = value;
        }
    }

    _publicStats(stats) {
        return {
            bytes: toNumber(stats.bytes),
            totalBytes: toNumber(stats.totalBytes),
            transfers: toNumber(stats.transfers),
            totalTransfers: toNumber(stats.totalTransfers),
            checks: toNumber(stats.checks),
            totalChecks: toNumber(stats.totalChecks),
            deletes: toNumber(stats.deletes),
            deletedDirs: toNumber(stats.deletedDirs),
            renames: toNumber(stats.renames),
            errors: toNumber(stats.errors),
            listed: toNumber(stats.listed),
            elapsedTime: toNumber(stats.elapsedTime),
            speed: toNumber(stats.speed),
            eta: stats.eta ?? null,
            fatalError: Boolean(stats.fatalError),
            retryError: Boolean(stats.retryError),
        };
    }

    runCapture(args) {
        const argv = [this.binary, ...this.commonArgs(), ...args];
        const subprocess = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        const [ok, stdout, stderr] = subprocess.communicate_utf8(null, null);
        return {
            ok,
            exitCode: subprocess.get_if_exited() ? subprocess.get_exit_status() : -1,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            argv,
        };
    }

    getVersion() {
        if (this._version)
            return this._version;
        const result = this.runCapture(['version']);
        if (result.exitCode !== 0)
            throw new Error(`rclone version failed: ${result.stderr.trim()}`);
        const firstLine = result.stdout.split('\n')[0].trim();
        const match = firstLine.match(/v(\d+\.\d+\.\d+)/);
        if (!match)
            throw new Error(`Cannot parse rclone version: ${firstLine}`);
        this._version = {
            text: match[1],
            major: Number(match[1].split('.')[0]),
            minor: Number(match[1].split('.')[1]),
            patch: Number(match[1].split('.')[2]),
            firstLine,
        };
        return this._version;
    }

    checkVersion(minVersion = RCLONE_MIN_VERSION) {
        const current = this.getVersion();
        const min = minVersion.split('.').map(Number);
        const cur = [current.major, current.minor, current.patch];
        for (let i = 0; i < 3; i++) {
            if (cur[i] > min[i])
                return true;
            if (cur[i] < min[i])
                return false;
        }
        return true;
    }

    configDump() {
        const result = this.runCapture(['config', 'dump']);
        if (result.exitCode !== 0)
            throw new Error(`rclone config dump failed: ${result.stderr.trim()}`);
        try {
            return JSON.parse(result.stdout);
        } catch (e) {
            throw new Error(`Invalid rclone config dump: ${e.message}`, {cause: e});
        }
    }

    listRemoteNames() {
        return Object.keys(this.configDump()).sort();
    }

    size(path, {fastList = false} = {}) {
        const args = ['size', path, '--json'];
        if (fastList)
            args.push('--fast-list');
        const result = this.runCapture(args);
        if (result.exitCode !== 0)
            throw new Error(`rclone size failed for ${path}: ${result.stderr.trim()}`);
        try {
            return JSON.parse(result.stdout);
        } catch (e) {
            throw new Error(`Invalid rclone size output: ${e.message}`, {cause: e});
        }
    }

    async sizeAsync(path, {fastList = false, cancellable = null} = {}) {
        const args = ['size', path, '--json'];
        if (fastList)
            args.push('--fast-list');
        let size = null;
        let lastError = null;
        const result = await this.run(args, {
            cancellable,
            onLine: (_raw, parsed) => {
                if (parsed && typeof parsed.count === 'number' &&
                    typeof parsed.bytes === 'number')
                    size = parsed;
                if (parsed?.level === 'error' || parsed?.level === 'critical')
                    lastError = parsed.msg;
            },
        });
        if (result.exitCode !== 0)
            throw new Error(lastError || `rclone size failed for ${path}`);
        if (!size)
            throw new Error(`Invalid rclone size output for ${path}`);
        return size;
    }

    configCreate(name, type, options = {}) {
        const args = ['config', 'create', name, type, '--non-interactive'];
        for (const [key, value] of Object.entries(options))
            args.push(`${key}=${value}`);
        return this.runCapture(args);
    }

    configDelete(name) {
        return this.runCapture(['config', 'delete', name]);
    }
}
