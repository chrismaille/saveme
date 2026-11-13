import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {LogDialog} from '../log-dialog.js';
import {formatWhen} from '../presentation/format.js';

export class SettingsPage {
    constructor(window) {
        this.window = window;
        this.widget = new Adw.PreferencesPage();
        this.blockPauseUpdate = false;
        const daemonGroup = new Adw.PreferencesGroup({title: 'Daemon'});
        this.statusRow = new Adw.ActionRow({title: 'Status', subtitle: 'Unknown'});
        this.rcloneRow = new Adw.ActionRow({title: 'rclone', subtitle: 'Unknown'});
        this.pauseAllRow = new Adw.SwitchRow({title: 'Pause all jobs'});
        this.pauseAllRow.connect('notify::active', () => {
            if (this.blockPauseUpdate)
                return;
            this.window.client.pauseAll(this.pauseAllRow.active)
                .catch(e => this.window.toast(e.message));
        });
        this.doctorRow = new Adw.ActionRow({
            title: 'Diagnostics',
            subtitle: 'Check rclone, configuration and volumes.',
        });
        const doctorButton = new Gtk.Button({
            label: 'Run doctor',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        doctorButton.connect('clicked', () => this._runDoctor());
        this.doctorRow.add_suffix(doctorButton);
        this.logsRow = new Adw.ActionRow({
            title: 'Log files',
            subtitle: 'Open the log folder.',
        });
        const logsButton = new Gtk.Button({
            label: 'Open folder',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        logsButton.connect('clicked', () => this._openLogsFolder());
        this.logsRow.add_suffix(logsButton);
        daemonGroup.add(this.statusRow);
        daemonGroup.add(this.rcloneRow);
        daemonGroup.add(this.pauseAllRow);
        daemonGroup.add(this.doctorRow);
        daemonGroup.add(this.logsRow);
        this.widget.add(daemonGroup);

        const aboutGroup = new Adw.PreferencesGroup({title: 'About'});
        this.versionRow = new Adw.ActionRow({title: 'Version'});
        aboutGroup.add(this.versionRow);
        this.widget.add(aboutGroup);
    }

    update(snapshot) {
        const daemon = snapshot.daemon || {};
        this.statusRow.set_subtitle(
            `Running · PID ${daemon.pid ?? '?'} · started ${formatWhen(daemon.startedAt)}`);
        this.rcloneRow.set_subtitle(
            `${daemon.rclone?.version || 'unknown'} · ${daemon.rclone?.path || '-'}`);
        this.blockPauseUpdate = true;
        this.pauseAllRow.active = Boolean(snapshot.pausedAll);
        this.blockPauseUpdate = false;
        this.versionRow.set_subtitle(snapshot.version || '-');
    }

    async _runDoctor() {
        try {
            const data = await this.window.client.doctor();
            new LogDialog(this.window, 'Doctor', JSON.stringify(data, null, 2)).present();
        } catch (e) {
            this.window.toast(e.message);
        }
    }

    _openLogsFolder() {
        const path = GLib.build_filenamev([GLib.get_user_state_dir(), 'saveme', 'logs']);
        try {
            this.window.launcher.openPath(path);
        } catch (e) {
            this.window.toast(e.message);
        }
    }
}
