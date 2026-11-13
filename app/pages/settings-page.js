import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {LogDialog} from '../log-dialog.js';
import {formatBytes, formatWhen} from '../presentation/format.js';

export class SettingsPage {
    constructor(window) {
        this.window = window;
        this.widget = new Adw.PreferencesPage();
        this.blockPauseUpdate = false;
        this.blockPolicyUpdate = false;
        this.policyDirty = false;
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

        const performanceGroup = new Adw.PreferencesGroup({
            title: 'Performance',
            description: 'Sampled from this app process and written to the application log.',
        });
        this.memoryRow = new Adw.ActionRow({title: 'Memory', subtitle: 'Waiting for sample'});
        this.cpuRow = new Adw.ActionRow({title: 'CPU', subtitle: 'Waiting for sample'});
        this.perfStatusRow = new Adw.ActionRow({title: 'Budget', subtitle: 'Waiting for sample'});
        this.perfSamplesRow = new Adw.ActionRow({title: 'Samples', subtitle: '-'});
        performanceGroup.add(this.memoryRow);
        performanceGroup.add(this.cpuRow);
        performanceGroup.add(this.perfStatusRow);
        performanceGroup.add(this.perfSamplesRow);
        this.widget.add(performanceGroup);

        const policyGroup = new Adw.PreferencesGroup({
            title: 'Log policy',
            description: 'Logs are sanitized before display and cleaned automatically.',
        });
        this.retentionRow = new Adw.SpinRow({
            title: 'Keep logs for',
            subtitle: 'days',
            digits: 0,
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 365,
                step_increment: 1,
                page_increment: 7,
            }),
        });
        this.maxSizeRow = new Adw.SpinRow({
            title: 'Maximum total log size',
            subtitle: 'MiB',
            digits: 0,
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 1024,
                step_increment: 10,
                page_increment: 50,
            }),
        });
        for (const row of [this.retentionRow, this.maxSizeRow]) {
            row.connect('notify::value', () => {
                if (!this.blockPolicyUpdate)
                    this.policyDirty = true;
            });
        }
        this.savePolicyRow = new Adw.ActionRow({
            title: 'Apply log policy',
            subtitle: 'Save retention and size limits to the daemon.',
        });
        const savePolicyButton = new Gtk.Button({
            label: 'Save',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        savePolicyButton.connect('clicked', () => this._saveLogPolicy());
        this.savePolicyRow.add_suffix(savePolicyButton);
        policyGroup.add(this.retentionRow);
        policyGroup.add(this.maxSizeRow);
        policyGroup.add(this.savePolicyRow);
        this.widget.add(policyGroup);

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
        const settings = snapshot.settings || {};
        if (!this.policyDirty) {
            this.blockPolicyUpdate = true;
            this.retentionRow.value = Number(settings.logRetentionDays ?? 30);
            this.maxSizeRow.value = Math.max(1,
                Math.round(Number(settings.maxLogTotalBytes ?? 50 * 1024 * 1024) /
                    (1024 * 1024)));
            this.blockPolicyUpdate = false;
        }
    }

    updatePerformance(metrics) {
        if (!metrics) {
            this.memoryRow.set_subtitle('Waiting for sample');
            this.cpuRow.set_subtitle('Waiting for sample');
            this.perfStatusRow.set_subtitle('Waiting for sample');
            this.perfSamplesRow.set_subtitle('-');
            return;
        }
        this.memoryRow.set_subtitle(
            `${formatBytes(metrics.rssBytes)} · peak ${formatBytes(metrics.peakRssBytes)}`);
        this.cpuRow.set_subtitle(`${metrics.cpuPercent.toFixed(1)}%`);
        this.perfStatusRow.set_subtitle(metrics.budgetExceeded
            ? 'Budget exceeded — check the application log'
            : 'Within budget');
        this.perfSamplesRow.set_subtitle(
            `${metrics.samples} · last sample ${formatWhen(metrics.sampledAt)}`);
    }

    async _saveLogPolicy() {
        try {
            await this.window.client.updateSettings({
                logRetentionDays: Math.round(this.retentionRow.value),
                maxLogTotalBytes: Math.round(this.maxSizeRow.value) * 1024 * 1024,
            });
            this.policyDirty = false;
            this.window.toast('Log policy saved.');
        } catch (e) {
            this.window.toast(e.message);
        }
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
