import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {LogDialog} from '../log-dialog.js';
import {formatBytes, formatWhen} from '../presentation/format.js';
import {readTail} from '../widgets/common.js';
import {sanitizeLogText} from '../../src/domain/log-policy.js';

export class DebugPage {
    constructor(window) {
        this.window = window;
        this.widget = new Adw.PreferencesPage();
        this.snapshot = null;
        this.configPath = GLib.build_filenamev([GLib.get_user_config_dir(), 'saveme']);
        this.statePath = GLib.build_filenamev([GLib.get_user_state_dir(), 'saveme']);
        this.logPath = GLib.build_filenamev([this.statePath, 'daemon.log']);

        const systemGroup = new Adw.PreferencesGroup({title: 'System'});
        this.daemonRow = new Adw.ActionRow({title: 'Daemon'});
        this.rcloneRow = new Adw.ActionRow({title: 'rclone'});
        this.configRow = new Adw.ActionRow({title: 'Configuration', subtitle: this.configPath});
        const openConfig = new Gtk.Button({
            label: 'Open',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        openConfig.connect('clicked', () => this._openPath(this.configPath));
        this.configRow.add_suffix(openConfig);
        this.stateRow = new Adw.ActionRow({title: 'State and logs', subtitle: this.statePath});
        const openState = new Gtk.Button({
            label: 'Open',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        openState.connect('clicked', () => this._openPath(this.statePath));
        this.stateRow.add_suffix(openState);
        this.volumesRow = new Adw.ActionRow({title: 'Volumes'});
        systemGroup.add(this.daemonRow);
        systemGroup.add(this.rcloneRow);
        systemGroup.add(this.configRow);
        systemGroup.add(this.stateRow);
        systemGroup.add(this.volumesRow);
        this.widget.add(systemGroup);

        const performanceGroup = new Adw.PreferencesGroup({title: 'Performance'});
        this.memoryRow = new Adw.ActionRow({title: 'Memory', subtitle: 'Waiting for sample'});
        this.cpuRow = new Adw.ActionRow({title: 'CPU', subtitle: 'Waiting for sample'});
        this.perfStatusRow = new Adw.ActionRow({title: 'Budget', subtitle: 'Waiting for sample'});
        this.appLogRow = new Adw.ActionRow({
            title: 'Application log',
            subtitle: 'Memory/CPU samples and app errors.',
        });
        const appLogButton = new Gtk.Button({
            label: 'View',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        appLogButton.connect('clicked', () => this.window.openAppLog());
        this.appLogRow.add_suffix(appLogButton);
        performanceGroup.add(this.memoryRow);
        performanceGroup.add(this.cpuRow);
        performanceGroup.add(this.perfStatusRow);
        performanceGroup.add(this.appLogRow);
        this.widget.add(performanceGroup);

        const logGroup = new Adw.PreferencesGroup({title: 'Daemon log'});
        this.logView = new Gtk.TextView({
            editable: false,
            monospace: true,
            wrap_mode: Gtk.WrapMode.NONE,
            left_margin: 8,
            right_margin: 8,
            top_margin: 8,
            bottom_margin: 8,
        });
        this.logView.add_css_class('saveme-log-view');
        const scrolled = new Gtk.ScrolledWindow({vexpand: true});
        scrolled.set_size_request(-1, 320);
        scrolled.set_child(this.logView);
        logGroup.add(scrolled);

        const refreshRow = new Adw.ActionRow({
            title: 'Reload log',
            subtitle: 'Show the last 800 lines of daemon.log',
        });
        const refreshButton = new Gtk.Button({
            label: 'Refresh',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        refreshButton.connect('clicked', () => this.refreshLog(true));
        refreshRow.add_suffix(refreshButton);
        logGroup.add(refreshRow);
        this.widget.add(logGroup);

        const actions = new Adw.PreferencesGroup({title: 'Diagnostics'});
        const doctorRow = new Adw.ActionRow({
            title: 'Doctor',
            subtitle: 'Check rclone, paths, volumes and configuration.',
        });
        const doctorButton = new Gtk.Button({
            label: 'Run',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        doctorButton.connect('clicked', () => this._runDoctor());
        doctorRow.add_suffix(doctorButton);
        actions.add(doctorRow);

        const copyRow = new Adw.ActionRow({
            title: 'Copy diagnostics',
            subtitle: 'Snapshot, doctor output and recent daemon log.',
        });
        const copyButton = new Gtk.Button({
            label: 'Copy',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        copyButton.connect('clicked', () => this._copyDiagnostics());
        copyRow.add_suffix(copyButton);
        actions.add(copyRow);
        this.widget.add(actions);
    }

    update(snapshot) {
        this.snapshot = snapshot;
        const daemon = snapshot.daemon || {};
        this.daemonRow.set_subtitle(
            `Running · PID ${daemon.pid ?? '?'} · started ${formatWhen(daemon.startedAt)}`);
        this.rcloneRow.set_subtitle(
            `${daemon.rclone?.version || 'unknown'} · ${daemon.rclone?.path || '-'}`);
        this.volumesRow.set_subtitle(
            `${(snapshot.volumes || []).length} mounted volume(s)`);
    }

    onShown() {
        this.refreshLog(false);
    }

    updatePerformance(metrics) {
        if (!metrics) {
            this.memoryRow.set_subtitle('Waiting for sample');
            this.cpuRow.set_subtitle('Waiting for sample');
            this.perfStatusRow.set_subtitle('Waiting for sample');
            return;
        }
        this.memoryRow.set_subtitle(
            `${formatBytes(metrics.rssBytes)} · peak ${formatBytes(metrics.peakRssBytes)}`);
        this.cpuRow.set_subtitle(`${metrics.cpuPercent.toFixed(1)}%`);
        this.perfStatusRow.set_subtitle(metrics.budgetExceeded
            ? 'Budget exceeded — check the application log'
            : `Within budget · ${metrics.samples} samples`);
    }

    _openPath(path) {
        try {
            this.window.launcher.openPath(path);
        } catch (e) {
            this.window.toast(e.message);
        }
    }

    refreshLog(showToast = false) {
        const text = readTail(this.logPath, 800);
        this.logView.get_buffer().set_text(text || '(empty)', -1);
        if (showToast)
            this.window.toast('Daemon log refreshed.');
    }

    async _runDoctor() {
        try {
            const data = await this.window.client.doctor();
            new LogDialog(this.window, 'Doctor', JSON.stringify(data, null, 2)).present();
        } catch (e) {
            this.window.toast(e.message);
        }
    }

    async _copyDiagnostics() {
        const parts = [
            `SaveMe ${this.snapshot?.version || '?'}`,
            `Snapshot:\n${JSON.stringify(this.snapshot || {}, null, 2)}`,
            `Performance:\n${JSON.stringify(this.window.monitor?.snapshot() || {}, null, 2)}`,
        ];
        try {
            parts.push(`Doctor:\n${JSON.stringify(await this.window.client.doctor(), null, 2)}`);
        } catch (e) {
            parts.push(`Doctor error: ${e.message}`);
        }
        parts.push(`Daemon log:\n${readTail(this.logPath, 400) || '(empty)'}`);
        parts.push(`Application log:\n${this.window.appLog?.readTail(400) || '(empty)'}`);
        try {
            this.widget.get_clipboard().set(sanitizeLogText(parts.join('\n\n')));
            this.window.toast('Diagnostics copied.');
        } catch (e) {
            this.window.toast(`Cannot copy diagnostics: ${e.message}`);
        }
    }
}
