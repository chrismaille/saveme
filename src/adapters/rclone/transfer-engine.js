import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {isExecutable} from '../../util.js';
import {bundledRclone, projectRclone} from '../../paths.js';
import {
    emptyRcloneStats,
    exitCodeMessage,
    isSuccessExit,
    mergeStats,
    parseRcloneLine,
    publicStats,
} from '../../domain/rclone-log.js';

export {exitCodeMessage, isSuccessExit};

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

export class RcloneTransferEngine {
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
        const stats = emptyRcloneStats();
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
        callback(parseRcloneLine(line));
    }

    _mergeStats(target, incoming) {
        return mergeStats(target, incoming);
    }

    _publicStats(stats) {
        return publicStats(stats);
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

    fetchJson(url, {headers = {}} = {}) {
        const directory = GLib.dir_make_tmp('saveme-http-XXXXXX');
        const configPath = GLib.build_filenamev([directory, 'curl.conf']);
        const escape = value => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const lines = [`url = "${escape(url)}"`];
        for (const [name, value] of Object.entries(headers))
            lines.push(`header = "${escape(name)}: ${escape(value)}"`);
        try {
            GLib.file_set_contents(configPath, `${lines.join('\n')}\n`);
            Gio.File.new_for_path(configPath).set_attribute_uint32(
                'unix::mode', 0o600, Gio.FileQueryInfoFlags.NONE, null);
            const subprocess = Gio.Subprocess.new(
                ['curl', '-fsS', '--config', configPath],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            const [ok, stdout, stderr] = subprocess.communicate_utf8(null, null);
            if (!ok) {
                throw new Error(stderr.trim() ||
                    `HTTP request failed with code ${subprocess.get_exit_status()}`);
            }
            return JSON.parse(stdout);
        } finally {
            try {
                Gio.File.new_for_path(configPath).delete(null);
                Gio.File.new_for_path(directory).delete(null);
            } catch (_) {
                // Best effort.
            }
        }
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

    about(path) {
        const result = this.runCapture(['about', path, '--json']);
        if (result.exitCode !== 0)
            throw new Error(result.stderr.trim() ||
                `rclone about failed for ${path}`);
        try {
            return JSON.parse(result.stdout || '{}');
        } catch (e) {
            throw new Error(`Invalid rclone about output: ${e.message}`, {cause: e});
        }
    }

    listRemoteNames() {
        return Object.keys(this.configDump()).sort();
    }

    size(path, {fastList = false, maxDepth = null} = {}) {
        const args = ['size', path, '--json'];
        if (fastList)
            args.push('--fast-list');
        if (maxDepth !== null)
            args.push('--max-depth', String(maxDepth));
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

    exists(path) {
        const result = this.runCapture(['lsf', path, '--max-depth', '1']);
        if (result.exitCode === 3)
            return false;
        if (!isSuccessExit(result.exitCode)) {
            throw new Error(result.stderr.trim() ||
                `Cannot check ${path}: ${exitCodeMessage(result.exitCode)}`);
        }
        return true;
    }

    mkdir(path) {
        const result = this.runCapture(['mkdir', path]);
        if (!isSuccessExit(result.exitCode)) {
            throw new Error(result.stderr.trim() ||
                `Cannot create ${path}: ${exitCodeMessage(result.exitCode)}`);
        }
        return result;
    }

    listDirs(path) {
        const result = this.runCapture(['lsf', path, '--dirs-only', '--max-depth', '1']);
        if (result.exitCode === 3)
            return [];
        if (!isSuccessExit(result.exitCode)) {
            throw new Error(result.stderr.trim() ||
                `Cannot list ${path}: ${exitCodeMessage(result.exitCode)}`);
        }
        return result.stdout.split('\n')
            .map(line => line.trim().replace(/\/$/, ''))
            .filter(Boolean);
    }

    readText(path) {
        const result = this.runCapture(['cat', path]);
        if (!isSuccessExit(result.exitCode)) {
            throw new Error(result.stderr.trim() ||
                `Cannot read ${path}: ${exitCodeMessage(result.exitCode)}`);
        }
        return result.stdout;
    }

    writeText(path, text) {
        const directory = GLib.dir_make_tmp('saveme-write-XXXXXX');
        const temporary = GLib.build_filenamev([directory, 'payload']);
        try {
            GLib.file_set_contents(temporary, String(text));
            const result = this.runCapture(['copyto', temporary, path]);
            if (!isSuccessExit(result.exitCode)) {
                throw new Error(result.stderr.trim() ||
                    `Cannot write ${path}: ${exitCodeMessage(result.exitCode)}`);
            }
            return result;
        } finally {
            try {
                Gio.File.new_for_path(temporary).delete(null);
            } catch (_) {
                // Ignore.
            }
            try {
                Gio.File.new_for_path(directory).delete(null);
            } catch (_) {
                // Ignore.
            }
        }
    }
}
