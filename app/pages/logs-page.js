import Pango from 'gi://Pango';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {LogDialog} from '../log-dialog.js';
import {descriptorDisplay} from '../../src/jobs.js';
import {t} from '../../src/i18n.js';
import {
    RESULT_LABELS,
    formatBytes,
    formatEta,
    formatWhen,
    resultClass,
    runDuration,
    statusLabel,
    truncate,
    typeLabel,
} from '../presentation/format.js';
import {basenameOf} from '../widgets/common.js';

export class LogsPage {
    constructor(window) {
        this.window = window;
        this.widget = new Adw.PreferencesPage();
        this.jobs = [];
        this.jobIds = [];
        this.pendingJobId = null;
        this.structureKey = null;
        this.runsKey = null;
        this.loadToken = 0;
        this.storageLoaded = false;

        this.summaryGroup = new Adw.PreferencesGroup({title: t('Status')});
        this.statusRow = new Adw.ActionRow({title: t('Job'), subtitle: t('No job selected')});
        this.destinationRow = new Adw.ActionRow({title: t('Destination')});
        this.openDestination = new Gtk.Button({
            label: t('Open'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        this.openDestination.connect('clicked', () => {
            const job = this._selectedJob();
            if (job)
                this.window.openDestination(job);
        });
        this.destinationRow.add_suffix(this.openDestination);
        this.progress = new Gtk.ProgressBar({show_text: true, visible: false});
        this.currentLabel = new Gtk.Label({
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.END,
            visible: false,
            css_classes: ['dim-label'],
        });
        const progressBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            margin_top: 6,
            margin_bottom: 6,
        });
        progressBox.append(this.progress);
        progressBox.append(this.currentLabel);
        this.activeRow = new Adw.ActionRow({title: t('Active run')});
        this.cancelButton = new Gtk.Button({
            label: t('Stop'),
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        this.cancelButton.connect('clicked', () => {
            const job = this._selectedJob();
            if (!job)
                return;
            this.window.client.cancelJob(job.id)
                .catch(e => this.window.toast(e.message));
        });
        this.activeRow.add_suffix(this.cancelButton);
        this.summaryGroup.add(this.statusRow);
        this.summaryGroup.add(this.destinationRow);
        this.summaryGroup.add(progressBox);
        this.summaryGroup.add(this.activeRow);
        this.widget.add(this.summaryGroup);

        const storageGroup = new Adw.PreferencesGroup({
            title: t('Log storage'),
            description: t('Daemon and run logs are sanitized before display.'),
        });
        this.storageUsageRow = new Adw.ActionRow({
            title: t('Daemon and run logs'),
            subtitle: t('Loading…'),
        });
        const refreshLogs = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: t('Refresh log storage'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        refreshLogs.connect('clicked', () => this._refreshStorage());
        this.storageUsageRow.add_suffix(refreshLogs);
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
        this.clearRunsRow = new Adw.ActionRow({
            title: t('Run logs'),
            subtitle: t('Delete job run logs and rclone traces.'),
        });
        const clearRuns = new Gtk.Button({
            label: t('Clear'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat', 'destructive-action'],
        });
        clearRuns.connect('clicked', () => {
            this.window.confirm(t('Clear run logs?'),
                t('Delete all job run logs and rclone traces?'),
                true, () => this._clearLogs('run-logs'));
        });
        this.clearRunsRow.add_suffix(clearRuns);
        this.clearDaemonRow = new Adw.ActionRow({
            title: t('Daemon log'),
            subtitle: t('Delete the live daemon log.'),
        });
        const clearDaemon = new Gtk.Button({
            label: t('Clear'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat', 'destructive-action'],
        });
        clearDaemon.connect('clicked', () => {
            this.window.confirm(t('Clear daemon log?'),
                t('Delete the daemon log? Diagnostics from the current session will be lost.'),
                true, () => this._clearLogs('daemon'));
        });
        this.clearDaemonRow.add_suffix(clearDaemon);
        this.sanitizeRow = new Adw.ActionRow({
            title: t('Sanitize existing logs'),
            subtitle: t('Redact credentials that may already be on disk.'),
        });
        const sanitize = new Gtk.Button({
            label: t('Sanitize'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        sanitize.connect('clicked', () => this._sanitizeLogs());
        this.sanitizeRow.add_suffix(sanitize);
        storageGroup.add(this.storageUsageRow);
        storageGroup.add(this.storagePolicyRow);
        storageGroup.add(this.clearRunsRow);
        storageGroup.add(this.clearDaemonRow);
        storageGroup.add(this.sanitizeRow);
        this.widget.add(storageGroup);

        const appLogGroup = new Adw.PreferencesGroup({
            title: t('Application log'),
            description: t('Memory/CPU samples and app errors.'),
        });
        this.appLogRow = new Adw.ActionRow({
            title: t('Application log'),
            subtitle: t('Loading…'),
        });
        const viewAppLog = new Gtk.Button({
            label: t('View'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        viewAppLog.connect('clicked', () => this.window.openAppLog());
        const clearAppLog = new Gtk.Button({
            label: t('Clear'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat', 'destructive-action'],
        });
        clearAppLog.connect('clicked', () => {
            this.window.confirm(t('Clear application log?'),
                t('Delete the app log and its rotated backup?'),
                true, () => {
                    this.window.appLog?.clear();
                    this.window.toast(t('Application log cleared.'));
                    this._refreshStorage();
                });
        });
        this.appLogRow.add_suffix(viewAppLog);
        this.appLogRow.add_suffix(clearAppLog);
        appLogGroup.add(this.appLogRow);
        this.widget.add(appLogGroup);

        const filterGroup = new Adw.PreferencesGroup({title: t('Select job')});
        this.jobRow = new Adw.ComboRow({
            title: t('Job'),
            model: Gtk.StringList.new([t('No jobs')]),
        });
        this.jobRow.connect('notify::selected', () => {
            this._loadRuns();
            this._updateSummary();
        });
        filterGroup.add(this.jobRow);
        this.widget.add(filterGroup);

        this.runsGroup = new Adw.PreferencesGroup({title: t('Runs')});
        this.widget.add(this.runsGroup);
        this._updateSummary();
    }

    onShown() {
        this._refreshStorage();
        this._loadRuns();
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
            this._renderStorage(info, appInfo);
        } catch (e) {
            this.storageUsageRow.set_subtitle(t('Cannot read logs: {message}',
                {message: e.message}));
        }
    }

    _renderStorage(info, appInfo) {
        const oldest = info.oldest
            ? ` · ${t('oldest')} ${formatWhen(info.oldest)}` : '';
        this.storageUsageRow.set_subtitle(
            `${info.files || 0} ${t('files')} · ${formatBytes(info.totalBytes || 0)}${oldest}`);
        const policy = info.policy || {};
        this.storagePolicyRow.set_subtitle(
            `${policy.retentionDays ?? 30} ${t('days')} · max ` +
            `${formatBytes(policy.maxTotalBytes || 0)}`);
        this.appLogRow.set_subtitle(
            `${appInfo.files || 0} ${t('files')} · ${formatBytes(appInfo.totalBytes || 0)}` +
            (this.window.appLog?.path ? ` · ${this.window.appLog.path}` : ''));
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

    _selectedJob() {
        const id = this.jobIds[this.jobRow.selected];
        return this.jobs.find(job => job.id === id) || null;
    }

    update(snapshot) {
        const jobs = snapshot.jobs || [];
        const listKey = jobs.map(job => `${job.id}:${job.name}`).join('|');
        const runsKey = jobs.map(job =>
            `${job.id}:${job.state?.lastRunId || ''}:${job.state?.lastRunAt || ''}`)
            .join('|');
        this.jobs = jobs;
        this.jobIds = jobs.map(job => job.id);
        this._updateSummary();
        if (!this.storageLoaded) {
            this.storageLoaded = true;
            this._refreshStorage();
        }
        const listChanged = listKey !== this.structureKey;
        if (listChanged) {
            this.structureKey = listKey;
            const previous = this.pendingJobId || this.jobIds[this.jobRow.selected];
            const labels = jobs.map(job => job.name || job.id);
            this.jobRow.model = Gtk.StringList.new(labels.length ? labels : [t('No jobs')]);
            let index = previous ? this.jobIds.indexOf(previous) : 0;
            if (index < 0)
                index = 0;
            this.jobRow.selected = index;
        }
        if (listChanged || runsKey !== this.runsKey) {
            this.runsKey = runsKey;
            this._loadRuns();
        }
    }

    _updateSummary() {
        const job = this._selectedJob();
        if (!job) {
            this.statusRow.set_title(t('Job'));
            this.statusRow.set_subtitle(t('No job selected'));
            this.destinationRow.set_subtitle('-');
            this.progress.visible = false;
            this.currentLabel.visible = false;
            this.activeRow.visible = false;
            return;
        }
        const state = job.state || {};
        const progress = state.progress;
        this.statusRow.set_title(job.name || job.id);
        this.statusRow.set_subtitle(
            `${typeLabel(job.type)} · ${statusLabel(state.status)}` +
            (state.lastRunAt
                ? ` · ${t('last run')} ${formatWhen(state.lastRunAt)}` : ''));
        this.destinationRow.set_subtitle(
            descriptorDisplay(job.destination, this.window.volumes));

        const running = state.status === 'running';
        this.activeRow.visible = running;
        if (progress) {
            this.progress.visible = true;
            this.progress.set_fraction(
                Math.max(0, Math.min(1, Number(progress.percent || 0) / 100)));
            this.progress.set_text(
                `${Math.round(progress.percent || 0)}% · ` +
                `${formatBytes(progress.bytes)} / ${formatBytes(progress.totalBytes)}`);
            const currentPath = progress.currentPath || progress.currentFile;
            if (currentPath) {
                this.currentLabel.set_text(
                    truncate(basenameOf(currentPath), 72));
                this.currentLabel.set_tooltip_text(currentPath);
                this.currentLabel.visible = true;
            } else {
                this.currentLabel.visible = false;
            }
            this.activeRow.set_subtitle(
                `${progress.files || 0} / ${progress.totalFiles || 0} ${t('files')} · ` +
                `${formatBytes(progress.bytes)} / ${formatBytes(progress.totalBytes)} · ` +
                `ETA ${formatEta(progress.eta)}`);
        } else {
            this.progress.visible = false;
            this.currentLabel.visible = false;
            this.activeRow.set_subtitle(t('Running'));
        }
        this.cancelButton.visible = running;
    }

    async _loadRuns() {
        const jobId = this.jobIds[this.jobRow.selected];
        if (!jobId) {
            this._renderRuns([], null);
            return;
        }
        const token = ++this.loadToken;
        try {
            const runs = await this.window.client.listRuns(jobId, 50);
            if (token !== this.loadToken)
                return;
            this._renderRuns(runs, jobId);
        } catch (e) {
            if (token === this.loadToken)
                this.window.toast(t('Cannot load runs: {message}', {message: e.message}));
        }
    }

    _renderRuns(runs, jobId) {
        this.widget.remove(this.runsGroup);
        this.runsGroup = new Adw.PreferencesGroup({title: t('Runs')});
        if (runs.length === 0) {
            this.runsGroup.add(new Adw.ActionRow({
                title: t('No runs yet'),
                subtitle: t('Run the job to see results here.'),
            }));
        } else {
            for (const run of runs) {
                const stats = run.stats || {};
                const parts = [
                    run.kind === 'sync' || run.kind === 'backup'
                        ? typeLabel(run.kind) : t(run.kind || 'run'),
                    run.dryRun ? t('dry run') : null,
                    `${stats.transfers || 0} ${t('files')}`,
                    formatBytes(stats.bytes || 0),
                    `${stats.deletes || 0} ${t('deletes')}`,
                    `${stats.errors || 0} ${t('errors')}`,
                    runDuration(run),
                ].filter(Boolean);
                if (run.message)
                    parts.push(run.message);
                const row = new Adw.ActionRow({
                    title: `${t(RESULT_LABELS[run.result] || run.result)} · ${formatWhen(run.startedAt)}`,
                    subtitle: parts.join(' · '),
                });
                const dot = new Gtk.Image({
                    icon_name: run.result === 'error' ? 'dialog-error-symbolic'
                        : run.result === 'cancelled' ? 'media-playback-pause-symbolic'
                            : 'emblem-ok-symbolic',
                    pixel_size: 14,
                });
                dot.add_css_class(resultClass(run.result));
                row.add_prefix(dot);
                const view = new Gtk.Button({
                    label: t('View log'),
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                view.connect('clicked', () => {
                    if (!jobId)
                        return;
                    this.window.client.getRunLog(jobId, run.id)
                        .then(text => new LogDialog(
                            this.window,
                            `Log — ${run.id}`,
                            text).present())
                        .catch(e => this.window.toast(e.message));
                });
                row.add_suffix(view);
                this.runsGroup.add(row);
            }
        }
        this.widget.add(this.runsGroup);
    }

    selectJob(jobId) {
        this.pendingJobId = jobId;
        const index = this.jobIds.indexOf(jobId);
        if (index >= 0) {
            this.jobRow.selected = index;
            this._updateSummary();
            this._loadRuns();
        }
    }
}
