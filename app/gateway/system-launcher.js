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
}
