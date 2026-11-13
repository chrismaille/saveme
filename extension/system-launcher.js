import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * Extension-side OS launcher. Keeps subprocess ownership out of the panel
 * widget and makes the app-opening path testable without GNOME Shell.
 */
export class SystemLauncher {
    constructor({
        findProgram = GLib.find_program_in_path,
        subprocess = Gio.Subprocess,
    } = {}) {
        this._findProgram = findProgram;
        this._subprocess = subprocess;
    }

    find(name) {
        return this._findProgram(name);
    }

    spawn(argv) {
        return this._subprocess.new(argv, Gio.SubprocessFlags.NONE);
    }
}
