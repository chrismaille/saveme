import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * Application gateway for OS integration: launching programs and opening
 * files with the user's default application. GTK pages must not call
 * Gio.Subprocess or Gio.AppInfo directly.
 */
export class SystemLauncher {
    constructor({
        subprocess = Gio.Subprocess,
        appInfo = Gio.AppInfo,
        file = Gio.File,
        findProgram = GLib.find_program_in_path,
    } = {}) {
        this._subprocess = subprocess;
        this._appInfo = appInfo;
        this._file = file;
        this._findProgram = findProgram;
    }

    find(name) {
        return this._findProgram(name);
    }

    spawn(argv, {silent = false} = {}) {
        const flags = silent
            ? Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
            : Gio.SubprocessFlags.NONE;
        return this._subprocess.new(argv, flags);
    }

    openPath(path) {
        return this._appInfo.launch_default_for_uri(
            this._file.new_for_path(path).get_uri(), null);
    }

    capture(argv) {
        return new Promise((resolve, reject) => {
            let subprocess;
            try {
                subprocess = this._subprocess.new(argv,
                    Gio.SubprocessFlags.STDOUT_PIPE |
                    Gio.SubprocessFlags.STDERR_PIPE);
            } catch (e) {
                reject(e);
                return;
            }
            subprocess.communicate_utf8_async(null, null, (proc, result) => {
                try {
                    const [, stdout, stderr] = proc.communicate_utf8_finish(result);
                    if (!proc.get_successful()) {
                        reject(new Error(String(stderr || '').trim() ||
                            'Command failed'));
                        return;
                    }
                    resolve(stdout);
                } catch (e) {
                    reject(e);
                }
            });
        });
    }
}
