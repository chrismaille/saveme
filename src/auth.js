import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {uniqueId} from './util.js';

export const AUTH_PROVIDERS = {
    drive: 'Google Drive',
    onedrive: 'Microsoft OneDrive',
    dropbox: 'Dropbox',
    nextcloud: 'Nextcloud',
};

const URL_RE = /(https?:\/\/[^\s]+)/;
const TOKEN_RE = /"access_token"\s*:/;

function sanitizeSession(session) {
    return {
        id: session.id,
        provider: session.provider,
        name: session.name,
        status: session.status,
        url: session.url,
        error: session.error,
        createdAt: session.createdAt,
        lastLines: session.lastLines.slice(-12),
    };
}

export class RemoteAuthManager {
    constructor({rclone, config, logger, onChange = null}) {
        this.rclone = rclone;
        this.config = config;
        this.logger = logger;
        this.onChange = onChange;
        this.sessions = new Map();
    }

    begin(provider, name, options = {}) {
        if (!AUTH_PROVIDERS[provider])
            throw new Error(`Unsupported provider: ${provider}`);
        const remoteName = String(name || '').trim();
        if (!remoteName || /[:/\n\r]/.test(remoteName))
            throw new Error('Remote name cannot contain colon, slash or line breaks.');
        const existing = this.config.getRemote(remoteName);
        if (existing && existing.type !== provider)
            throw new Error(`Remote ${remoteName} already exists with another type.`);
        const active = [...this.sessions.values()].find(session =>
            ['starting', 'waiting', 'exchanging'].includes(session.status));
        if (active)
            throw new Error('Another authentication is already in progress. Cancel it first.');

        const authId = uniqueId('auth_');
        const session = {
            id: authId,
            provider,
            name: remoteName,
            options,
            status: 'starting',
            url: null,
            error: null,
            token: null,
            process: null,
            lastLines: [],
            createdAt: new Date().toISOString(),
        };
        this.sessions.set(authId, session);
        this._spawn(session);
        this._changed(session);
        return authId;
    }

    get(authId) {
        const session = this.sessions.get(authId);
        if (!session)
            throw new Error(`Authentication not found: ${authId}`);
        return JSON.stringify(sanitizeSession(session));
    }

    cancel(authId) {
        const session = this.sessions.get(authId);
        if (!session)
            return;
        if (session.process) {
            try {
                session.process.send_signal(2);
            } catch (_) {
                // Process may have exited.
            }
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
                try {
                    session.process?.force_exit();
                } catch (_) {
                    // Ignore.
                }
                return GLib.SOURCE_REMOVE;
            });
        }
        session.status = 'cancelled';
        this._changed(session);
    }

    stop() {
        for (const session of this.sessions.values()) {
            if (!session.process)
                continue;
            try {
                session.process.force_exit();
            } catch (_) {
                // Ignore.
            }
            session.process = null;
        }
        this.sessions.clear();
    }

    _changed(session) {
        this.onChange?.(session.id, JSON.stringify(sanitizeSession(session)));
    }

    _spawn(session) {
        const args = [
            '--config', this.rclone.configPath,
            'authorize', session.provider,
            '--auth-no-open-browser',
        ];
        const argv = [this.rclone.binary, ...args];
        this.logger?.info(`Starting OAuth for ${session.provider}`, {name: session.name});
        let process;
        try {
            process = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
        } catch (e) {
            session.status = 'error';
            session.error = e.message;
            this._changed(session);
            return;
        }
        session.process = process;
        const stream = Gio.DataInputStream.new(process.get_stdout_pipe());

        const readNext = () => {
            stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
                let line = null;
                try {
                    [line] = source.read_line_finish_utf8(result);
                } catch (e) {
                    this.logger?.warn(`Cannot read OAuth output: ${e.message}`);
                }
                if (line === null) {
                    this._waitForExit(session);
                    return;
                }
                this._handleLine(session, line);
                readNext();
            });
        };
        readNext();
    }

    _handleLine(session, line) {
        session.lastLines.push(line);
        if (session.lastLines.length > 50)
            session.lastLines.shift();
        this.logger?.debug(`OAuth: ${line}`);

        const linkMatch = line.match(/Please go to the following link:\s*(https?:\/\/\S+)/);
        if (linkMatch && !session.url) {
            session.url = linkMatch[1].replace(/["')\],.]+$/, '');
            session.status = 'waiting';
            this._changed(session);
        } else if (!session.url) {
            const urlMatch = line.match(URL_RE);
            if (urlMatch && urlMatch[1].includes('/auth?')) {
                session.url = urlMatch[1].replace(/["')\],.]+$/, '');
                session.status = 'waiting';
                this._changed(session);
            }
        }

        if (line.trim().startsWith('{') && TOKEN_RE.test(line)) {
            try {
                const token = JSON.parse(line.trim());
                if (token.access_token) {
                    session.token = token;
                    session.status = 'exchanging';
                    this._changed(session);
                }
            } catch (_) {
                // Not a complete token yet.
            }
        }

        if (line.includes('Got code') && session.status === 'waiting') {
            session.status = 'exchanging';
            this._changed(session);
        }
    }

    async _waitForExit(session) {
        const process = session.process;
        if (!process)
            return;
        await new Promise(resolve => {
            process.wait_async(null, (proc, result) => {
                try {
                    proc.wait_finish(result);
                } catch (_) {
                    // Process teardown.
                }
                resolve();
            });
        });
        session.process = null;
        if (session.status === 'cancelled')
            return;
        const exitCode = process.get_if_exited() ? process.get_exit_status() : -1;
        if (session.token) {
            try {
                this._createRemote(session);
                session.status = 'done';
                session.error = null;
            } catch (e) {
                session.status = 'error';
                session.error = e.message;
                this.logger?.error(`Cannot create remote ${session.name}: ${e.message}`);
            }
        } else {
            session.status = 'error';
            session.error = session.lastLines.slice(-4).join('\n') ||
                `rclone authorize exited with code ${exitCode}`;
        }
        this._changed(session);
    }

    _createRemote(session) {
        if (session.provider === 'onedrive')
            this._prepareOneDrive(session);
        const token = JSON.stringify(session.token);
        const existing = this.config.getRemote(session.name);
        const optionArgs = Object.entries(session.options || {})
            .map(([key, value]) => `${key}=${value}`);
        let result;
        if (existing) {
            result = this.rclone.runCapture(['config', 'update', session.name,
                'token', token, ...optionArgs, '--non-interactive']);
        } else {
            result = this.rclone.runCapture(['config', 'create', session.name,
                session.provider, 'token', token, ...optionArgs, '--non-interactive']);
        }
        if (result.exitCode !== 0) {
            const message = result.stderr.trim() || result.stdout.trim() ||
                `rclone config exited with code ${result.exitCode}`;
            throw new Error(this._friendlyRemoteError(message));
        }
        try {
            Gio.File.new_for_path(this.rclone.configPath).set_attribute_uint32(
                'unix::mode', 0o600, Gio.FileQueryInfoFlags.NONE, null);
        } catch (_) {
            // Best effort.
        }
        const label = `${AUTH_PROVIDERS[session.provider]} (${session.name})`;
        if (existing)
            this.config.updateRemote(session.name, {
                type: session.provider,
                label,
                options: session.options || {},
            });
        else
            this.config.addRemote({
                name: session.name,
                type: session.provider,
                label,
                options: session.options || {},
            });
        this._verifyRemote(session);
        this.logger?.info(`Remote ${session.name} configured`);
    }

    _prepareOneDrive(session) {
        const requested = session.options?.drive_type || 'personal';
        const drive = this._graphDrive(session.token, session.name);
        if (!drive)
            return;
        if (drive.type && requested && drive.type !== requested) {
            throw new Error(
                `The Microsoft account selected in the browser is ${drive.type}, ` +
                `but the app was configured for ${requested}. None was saved. ` +
                'Reconnect and choose the correct account in the browser ' +
                '(use a private window if needed).');
        }
        session.options = {
            ...(session.options || {}),
            drive_id: drive.id,
            drive_type: drive.type || requested,
        };
    }

    _graphDrive(token, remoteName) {
        if (!token?.access_token)
            return null;
        try {
            const data = this.rclone.fetchJson(
                'https://graph.microsoft.com/v1.0/me/drive', {
                    headers: {
                        Authorization: `Bearer ${token.access_token}`,
                    },
                });
            if (!data?.id)
                return null;
            return {
                id: data.id,
                type: data.driveType || null,
            };
        } catch (e) {
            this.logger?.warn(`Cannot query OneDrive drive for ${remoteName}: ${e.message}`);
            return null;
        }
    }

    _verifyRemote(session) {
        if (session.provider !== 'onedrive')
            return;
        const result = this.rclone.runCapture([
            'lsd', `${session.name}:`, '--max-depth', '1',
        ]);
        if (result.exitCode === 0)
            return;
        const message = result.stderr.trim() || result.stdout.trim() ||
            `rclone could not read ${session.name}.`;
        throw new Error(this._friendlyRemoteError(`OneDrive verification failed: ${message}`));
    }

    _friendlyRemoteError(message) {
        if (/drive_id|drive_type/i.test(message)) {
            return 'OneDrive was authenticated, but rclone could not identify the drive. ' +
                'This usually means the browser used a different account than the one ' +
                'selected. Delete this account in Accounts, then reconnect and choose the ' +
                'correct Microsoft account (use a private window if needed).';
        }
        return message;
    }
}
