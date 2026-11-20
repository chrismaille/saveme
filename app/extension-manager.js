import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const EXTENSION_UUID = 'saveme@chrismaille.github.io';

function exists(path) {
    return Gio.File.new_for_path(path).query_exists(null);
}

function modified(path) {
    try {
        const info = Gio.File.new_for_path(path).query_info(
            'time::modified', Gio.FileQueryInfoFlags.NONE, null);
        return Number(info.get_attribute_uint64('time::modified'));
    } catch (_) {
        return 0;
    }
}

/**
 * Install or refresh the GNOME Shell extension from the zip shipped
 * with the package. The PPA/apt packages update the zip; the app syncs it into
 * the user's extension directory and enables it without manual commands.
 */
export class ExtensionManager {
    constructor({
        launcher,
        logger = null,
        uuid = EXTENSION_UUID,
        zipPath = '/usr/share/saveme/extension.zip',
        systemDir = `/usr/share/gnome-shell/extensions/${EXTENSION_UUID}`,
        userDir = GLib.build_filenamev([
            GLib.get_user_data_dir(),
            'gnome-shell',
            'extensions',
            EXTENSION_UUID,
        ]),
        fileExists = exists,
        fileModified = modified,
    } = {}) {
        this.launcher = launcher;
        this.logger = logger;
        this.uuid = uuid;
        this.zipPath = zipPath;
        this.systemDir = systemDir;
        this.userDir = userDir;
        this.fileExists = fileExists;
        this.fileModified = fileModified;
    }

    async ensure() {
        if (!this.launcher?.find?.('gnome-extensions')) {
            this.logger?.info('GNOME extension skipped: gnome-extensions not found');
            return 'unavailable';
        }
        if (this.fileExists(this.systemDir)) {
            await this._enable();
            return 'system';
        }
        if (!this.fileExists(this.zipPath)) {
            this.logger?.info('GNOME extension skipped: package zip not found');
            return 'missing';
        }
        const installed = this.fileExists(this.userDir);
        if (!installed ||
            this.fileModified(this.zipPath) > this.fileModified(this.userDir)) {
            try {
                await this.launcher.capture([
                    'gnome-extensions', 'install', '--force', this.zipPath,
                ]);
                this.logger?.info('GNOME extension installed from package');
            } catch (e) {
                this.logger?.warn(`Cannot install GNOME extension: ${e.message}`);
                return 'failed';
            }
        }
        await this._enable();
        return 'user';
    }

    async _enable() {
        try {
            await this.launcher.capture([
                'gnome-extensions', 'enable', this.uuid,
            ]);
        } catch (e) {
            this.logger?.warn(`Cannot enable GNOME extension: ${e.message}`);
        }
    }
}
