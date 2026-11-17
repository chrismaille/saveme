import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {LogDialog} from './log-dialog.js';
import {t} from '../src/i18n.js';
import {formatBytes, formatWhen} from './presentation/format.js';
import {readTail} from './widgets/common.js';
import {sanitizeLogText} from '../src/domain/log-policy.js';

export class DiagnosticsPage {
    constructor(window) {
        this.window = window;
        this.widget = new Adw.PreferencesPage();
        this.snapshot = null;
        this.storageLoaded = false;
        this.configPath = GLib.build_filenamev([GLib.get_user_config_dir(), 'saveme']);
        this.statePath = GLib.build_filenamev([GLib.get_user_state_dir(), 'saveme']);
        this.logPath = GLib.build_filenamev([this.statePath, 'daemon.log']);
        this._build();
    }

    _build() {
        const system = new Adw.PreferencesGroup({title: t('System')});
        this.daemonRow = new Adw.ActionRow({title: t('Daemon')});
        this.rcloneRow = new Adw.ActionRow({title: 'rclone'});
        this.volumesRow = new Adw.ActionRow({title: t('Volumes')});
        this.configRow = new Adw.ActionRow({
            title: t('Configuration'),
            subtitle: this.configPath,
        });
        const openConfig = new Gtk.Button({
            label: t('Open'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        openConfig.connect('clicked', () => this._openPath(this.configPath));
        this.configRow.add_suffix(openConfig);
        this.stateRow = new Adw.ActionRow({
            title: t('State and logs'),
            subtitle: this.statePath,
        });
        const openState = new Gtk.Button({
            label: t('Open'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        openState.connect('clicked', () => this._openPath(this.statePath));
        this.stateRow.add_suffix(openState);
        system.add(this.daemonRow);
        system.add(this.rcloneRow);
        system.add(this.volumesRow);
        system.add(this.configRow);
        system.add(this.stateRow);
        this.widget.add(system);

        const actions = new Adw.PreferencesGroup({title: t('Diagnostics')});
        const doctorRow = new Adw.ActionRow({
            title: t('Doctor'),
            subtitle: t('Check rclone, paths, volumes and configuration.'),
        });
        const doctor = new Gtk.Button({
            label: t('Run'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        doctor.connect('clicked', () => this._runDoctor());
        doctorRow.add_suffix(doctor);
        actions.add(doctorRow);
        const copyRow = new Adw.ActionRow({
            title: t('Copy diagnostics'),
            subtitle: t('Snapshot, doctor output and recent logs.'),
        });
        const copy = new Gtk.Button({
            label: t('Copy'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        copy.connect('clicked', () => this._copyDiagnostics());
        copyRow.add_suffix(copy);
        actions.add(copyRow);
        const logsRow = new Adw.ActionRow({
            title: t('Log files'),
            subtitle: t('Open the log folder.'),
        });
        const openLogs = new Gtk.Button({
            label: t('Open folder'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        openLogs.connect('clicked', () => this._openPath(
            GLib.build_filenamev([this.statePath, 'logs'])));
        logsRow.add_suffix(openLogs);
        actions.add(logsRow);
        this.widget.add(actions);

        const storage = new Adw.PreferencesGroup({
            title: t('Log storage'),
            description: t('Daemon and run logs are sanitized before display.'),
        });
        this.storageUsageRow = new Adw.ActionRow({
            title: t('Daemon and run logs'),
            subtitle: t('Loading…'),
        });
        const refresh = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: t('Refresh log storage'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        refresh.connect('clicked', () => this._refreshStorage());
        this.storageUsageRow.add_suffix(refresh);
        this.storagePolicyRow = new Adw.ActionRow({
            title: t('Retention'),
            subtitle: t('Loading…'),
        });
        const cleanup = new Gtk.Button({
            label: t('Clean up'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        cleanup.connect('clicked', () => this._pruneLogs());
        this.storagePolicyRow.add_suffix(cleanup);
        const clearRuns = new Adw.ActionRow({
            title: t('Run logs'),
            subtitle: t('Delete job run logs and rclone traces.'),
        });
        const clearRunsButton = new Gtk.Button({
            label: t('Clear'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat', 'destructive-action'],
        });
        clearRunsButton.connect('clicked', () => {
            this.window.confirm(t('Clear run logs?'),
                t('Delete all job run logs and rclone traces?'),
                true, () => this._clearLogs('run-logs'));
        });
        clearRuns.add_suffix(clearRunsButton);
        const clearDaemon = new Adw.ActionRow({
            title: t('Daemon log'),
            subtitle: t('Delete the live daemon log.'),
        });
        const clearDaemonButton = new Gtk.Button({
            label: t('Clear'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat', 'destructive-action'],
        });
        clearDaemonButton.connect('clicked', () => {
            this.window.confirm(t('Clear daemon log?'),
                t('Delete the daemon log? Diagnostics from the current session will be lost.'),
                true, () => this._clearLogs('daemon'));
        });
        clearDaemon.add_suffix(clearDaemonButton);
        const sanitize = new Adw.ActionRow({
            title: t('Sanitize existing logs'),
            subtitle: t('Redact credentials that may already be on disk.'),
        });
        const sanitizeButton = new Gtk.Button({
            label: t('Sanitize'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        sanitizeButton.connect('clicked', () => this._sanitizeLogs());
        sanitize.add_suffix(sanitizeButton);
        storage.add(this.storageUsageRow);
        storage.add(this.storagePolicyRow);
        storage.add(clearRuns);
        storage.add(clearDaemon);
        storage.add(sanitize);
        this.widget.add(storage);

        const appLog = new Adw.PreferencesGroup({
            title: t('Application log'),
            description: t('Memory/CPU samples and app errors.'),
        });
        this.appLogRow = new Adw.ActionRow({
            title: t('Application log'),
            subtitle: t('Loading…'),
        });
        const view = new Gtk.Button({
            label: t('View'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        view.connect('clicked', () => this.window.openAppLog());
        const clear = new Gtk.Button({
            label: t('Clear'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat', 'destructive-action'],
        });
        clear.connect('clicked', () => {
            this.window.confirm(t('Clear application log?'),
                t('Delete the app log and its rotated backup?'),
                true, () => {
                    this.window.appLog?.clear();
                    this.window.toast(t('Application log cleared.'));
                    this._refreshStorage();
                });
        });
        this.appLogRow.add_suffix(view);
        this.appLogRow.add_suffix(clear);
        appLog.add(this.appLogRow);
        this.widget.add(appLog);

        const performance = new Adw.PreferencesGroup({
            title: t('Performance'),
            description: t('Sampled from this app process and the daemon.'),
        });
        this.memoryRow = new Adw.ActionRow({title: t('App memory'), subtitle: t('Waiting for sample')});
        this.cpuRow = new Adw.ActionRow({title: t('App CPU'), subtitle: t('Waiting for sample')});
        this.daemonMemoryRow = new Adw.ActionRow({
            title: t('Daemon memory'),
            subtitle: t('Waiting for daemon sample'),
        });
        this.machineCpuRow = new Adw.ActionRow({
            title: t('Machine CPU'),
            subtitle: t('Waiting for sample'),
        });
        this.machineMemoryRow = new Adw.ActionRow({
            title: t('Machine memory'),
            subtitle: t('Waiting for sample'),
        });
        this.perfStatusRow = new Adw.ActionRow({
            title: t('App budget'),
            subtitle: t('Waiting for sample'),
        });
        this.perfSamplesRow = new Adw.ActionRow({title: t('App samples'), subtitle: '-'});
        performance.add(this.memoryRow);
        performance.add(this.cpuRow);
        performance.add(this.daemonMemoryRow);
        performance.add(this.machineCpuRow);
        performance.add(this.machineMemoryRow);
        performance.add(this.perfStatusRow);
        performance.add(this.perfSamplesRow);
        this.widget.add(performance);

        const logGroup = new Adw.PreferencesGroup({title: t('Daemon log')});
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
            title: t('Reload log'),
            subtitle: t('Show the last 800 lines of daemon.log'),
        });
        const refreshButton = new Gtk.Button({
            label: t('Refresh'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        refreshButton.connect('clicked', () => this.refreshLog(true));
        refreshRow.add_suffix(refreshButton);
        logGroup.add(refreshRow);
        this.widget.add(logGroup);
    }

    update(snapshot) {
        this.snapshot = snapshot;
        const daemon = snapshot.daemon || {};
        this.daemonRow.set_subtitle(t('Running · PID {pid} · started {when}', {
            pid: daemon.pid ?? '?',
            when: formatWhen(daemon.startedAt),
        }));
        this.rcloneRow.set_subtitle(
            `${daemon.rclone?.version || t('unknown')} · ${daemon.rclone?.path || '-'}`);
        this.volumesRow.set_subtitle(
            t('{count} mounted volume(s)', {count: (snapshot.volumes || []).length}));
        if (!this.storageLoaded) {
            this.storageLoaded = true;
            this._refreshStorage();
        }
    }

    onShown() {
        this._refreshStorage();
        this.refreshLog(false);
    }

    updatePerformance(metrics) {
        if (!metrics) {
            this.memoryRow.set_subtitle(t('Waiting for sample'));
            this.cpuRow.set_subtitle(t('Waiting for sample'));
            this.perfStatusRow.set_subtitle(t('Waiting for sample'));
            this.perfSamplesRow.set_subtitle('-');
            return;
        }
        this.memoryRow.set_subtitle(
            `${formatBytes(metrics.rssBytes)} · ${t('peak')} ${formatBytes(metrics.peakRssBytes)}`);
        this.cpuRow.set_subtitle(`${metrics.cpuPercent.toFixed(1)}%`);
        this.perfStatusRow.set_subtitle(metrics.budgetExceeded
            ? t('Budget exceeded — check the application log')
            : t('Within budget'));
        this.perfSamplesRow.set_subtitle(
            `${metrics.samples} · ${t('last sample')} ${formatWhen(metrics.sampledAt)}`);
        const process = this.snapshot?.daemon?.process;
        this.daemonMemoryRow.set_subtitle(process
            ? `${formatBytes(process.rssBytes)} · ${t('peak')} ${formatBytes(process.peakRssBytes)}`
            : t('Waiting for daemon sample'));
        const system = this.snapshot?.system;
        this.machineCpuRow.set_subtitle(system
            ? `${Number(system.cpuPercent).toFixed(1)}%`
            : t('Waiting for sample'));
        this.machineMemoryRow.set_subtitle(system?.memory
            ? `${formatBytes(system.memory.usedBytes)} / ${formatBytes(system.memory.totalBytes)}`
            : t('Waiting for sample'));
    }

    async _refreshStorage() {
        try {
            const [info, appInfo] = await Promise.all([
                this.window.client.getLogsInfo(),
                Promise.resolve(this.window.appLog?.info() || {
                    files: 0,
                    totalBytes: 0,
                }),
            ]);
            const oldest = info.oldest
                ? ` · ${t('oldest')} ${formatWhen(info.oldest)}` : '';
            this.storageUsageRow.set_subtitle(
                `${info.files || 0} ${t('files')} · ` +
                `${formatBytes(info.totalBytes || 0)}${oldest}`);
            const policy = info.policy || {};
            this.storagePolicyRow.set_subtitle(
                `${policy.retentionDays ?? 30} ${t('days')} · max ` +
                `${formatBytes(policy.maxTotalBytes || 0)}`);
            this.appLogRow.set_subtitle(
                `${appInfo.files || 0} ${t('files')} · ` +
                `${formatBytes(appInfo.totalBytes || 0)}` +
                (this.window.appLog?.path ? ` · ${this.window.appLog.path}` : ''));
        } catch (e) {
            this.storageUsageRow.set_subtitle(t('Cannot read logs: {message}',
                {message: e.message}));
        }
    }

    async _pruneLogs() {
        try {
            const result = await this.window.client.pruneLogs();
            this.window.toast(t('Removed {count} log files · {size} freed.', {
                count: result.deleted || 0,
                size: formatBytes(result.bytesFreed || 0),
            }));
            await this._refreshStorage();
        } catch (e) {
            this.window.toast(e.message);
        }
    }

    async _clearLogs(scope) {
        try {
            const result = await this.window.client.clearLogs(scope);
            this.window.toast(t('Cleared {count} log files · {size} freed.', {
                count: result.deleted || 0,
                size: formatBytes(result.bytesFreed || 0),
            }));
            await this._refreshStorage();
        } catch (e) {
            this.window.toast(e.message);
        }
    }

    async _sanitizeLogs() {
        try {
            const [daemon, app] = await Promise.all([
                this.window.client.sanitizeLogs(),
                Promise.resolve(this.window.appLog?.sanitize() || {
                    files: 0,
                    changed: 0,
                }),
            ]);
            this.window.toast(t('Sanitized {files} files · {changed} changed.', {
                files: (daemon.files || 0) + (app.files || 0),
                changed: (daemon.changed || 0) + (app.changed || 0),
            }));
            await this._refreshStorage();
        } catch (e) {
            this.window.toast(e.message);
        }
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
            this.window.toast(t('Daemon log refreshed.'));
    }

    async _runDoctor() {
        try {
            const data = await this.window.client.doctor();
            new LogDialog(this.window, t('Doctor'), JSON.stringify(data, null, 2)).present();
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
            this.window.toast(t('Diagnostics copied.'));
        } catch (e) {
            this.window.toast(t('Cannot copy diagnostics: {message}', {message: e.message}));
        }
    }
}
