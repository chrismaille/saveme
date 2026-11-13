import Pango from 'gi://Pango';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {LogDialog} from '../log-dialog.js';
import {descriptorDisplay} from '../../src/jobs.js';
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
        this.loadToken = 0;

        this.summaryGroup = new Adw.PreferencesGroup({title: 'Status'});
        this.statusRow = new Adw.ActionRow({title: 'Job', subtitle: 'No job selected'});
        this.destinationRow = new Adw.ActionRow({title: 'Destination'});
        this.openDestination = new Gtk.Button({
            label: 'Open',
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
        this.activeRow = new Adw.ActionRow({title: 'Active run'});
        this.cancelButton = new Gtk.Button({
            label: 'Stop',
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

        const filterGroup = new Adw.PreferencesGroup({title: 'Select job'});
        this.jobRow = new Adw.ComboRow({
            title: 'Job',
            model: Gtk.StringList.new(['No jobs']),
        });
        this.jobRow.connect('notify::selected', () => {
            this._loadRuns();
            this._updateSummary();
        });
        filterGroup.add(this.jobRow);
        this.widget.add(filterGroup);

        this.runsGroup = new Adw.PreferencesGroup({title: 'Runs'});
        this.widget.add(this.runsGroup);
        this._updateSummary();
    }

    _selectedJob() {
        const id = this.jobIds[this.jobRow.selected];
        return this.jobs.find(job => job.id === id) || null;
    }

    update(snapshot) {
        const jobs = snapshot.jobs || [];
        const key = jobs.map(job =>
            `${job.id}:${job.name}:${job.state?.lastRunId || ''}:` +
            `${job.state?.lastRunAt || ''}`)
            .join('|');
        this.jobs = jobs;
        this.jobIds = jobs.map(job => job.id);
        this._updateSummary();
        if (key === this.structureKey)
            return;
        this.structureKey = key;
        const previous = this.pendingJobId || this.jobIds[this.jobRow.selected];
        const labels = jobs.map(job => job.name || job.id);
        this.jobRow.model = Gtk.StringList.new(labels.length ? labels : ['No jobs']);
        let index = previous ? this.jobIds.indexOf(previous) : 0;
        if (index < 0)
            index = 0;
        this.jobRow.selected = index;
        this._loadRuns();
    }

    _updateSummary() {
        const job = this._selectedJob();
        if (!job) {
            this.statusRow.set_title('Job');
            this.statusRow.set_subtitle('No job selected');
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
            (state.lastRunAt ? ` · last run ${formatWhen(state.lastRunAt)}` : ''));
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
                `${progress.files || 0} / ${progress.totalFiles || 0} files · ` +
                `${formatBytes(progress.bytes)} / ${formatBytes(progress.totalBytes)} · ` +
                `ETA ${formatEta(progress.eta)}`);
        } else {
            this.progress.visible = false;
            this.currentLabel.visible = false;
            this.activeRow.set_subtitle('Running');
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
                this.window.toast(`Cannot load runs: ${e.message}`);
        }
    }

    _renderRuns(runs, jobId) {
        this.widget.remove(this.runsGroup);
        this.runsGroup = new Adw.PreferencesGroup({title: 'Runs'});
        if (runs.length === 0) {
            this.runsGroup.add(new Adw.ActionRow({
                title: 'No runs yet',
                subtitle: 'Run the job to see results here.',
            }));
        } else {
            for (const run of runs) {
                const stats = run.stats || {};
                const parts = [
                    run.kind || 'run',
                    run.dryRun ? 'dry run' : null,
                    `${stats.transfers || 0} files`,
                    formatBytes(stats.bytes || 0),
                    `${stats.deletes || 0} deletes`,
                    `${stats.errors || 0} errors`,
                    runDuration(run),
                ].filter(Boolean);
                if (run.message)
                    parts.push(run.message);
                const row = new Adw.ActionRow({
                    title: `${RESULT_LABELS[run.result] || run.result} · ${formatWhen(run.startedAt)}`,
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
                    label: 'View log',
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
