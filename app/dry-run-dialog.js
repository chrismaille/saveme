import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {t} from '../src/i18n.js';
import {
    RESULT_LABELS,
    formatBytes,
    formatEta,
} from './presentation/format.js';

export const DryRunDialog = GObject.registerClass({
    GTypeName: 'SaveMeDryRunDialog',
}, class DryRunDialog extends Adw.Window {
    constructor(parentWindow, job) {
        super({
            transient_for: parentWindow,
            modal: true,
            title: t('Simulação — {name}', {name: job.name || job.id}),
            default_width: 760,
            default_height: 560,
        });
        this.window = parentWindow;
        this.client = parentWindow.client;
        this.job = job;
        this.runId = null;
        this.running = false;
        this.started = false;
        this.lastProgress = null;
        this._unsubscribe = null;
        this._build();
        this.connect('close-request', () => {
            this._cleanup();
            return false;
        });
        this._start();
    }

    _build() {
        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        header.set_title_widget(new Adw.WindowTitle({
            title: t('Simulação'),
            subtitle: this.job.name || this.job.id,
        }));
        this.closeButton = new Gtk.Button({label: t('Close')});
        this.closeButton.connect('clicked', () => this.close());
        header.pack_start(this.closeButton);
        this.cancelButton = new Gtk.Button({
            label: t('Cancel'),
            css_classes: ['destructive-action'],
        });
        this.cancelButton.connect('clicked', () => this._cancel());
        header.pack_end(this.cancelButton);
        toolbar.add_top_bar(header);

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 18,
            margin_bottom: 18,
            margin_start: 18,
            margin_end: 18,
        });
        box.append(new Gtk.Label({
            label: t('Verificação do backup'),
            xalign: 0,
            css_classes: ['title-2'],
        }));
        box.append(new Gtk.Label({
            label: t('Esta simulação percorre a origem e compara com o destino sem ' +
                'copiar, apagar ou alterar arquivos. O job real não é executado e a ' +
                'lista de tarefas não muda.'),
            xalign: 0,
            wrap: true,
            css_classes: ['dim-label'],
        }));
        this.progress = new Gtk.ProgressBar({
            show_text: false,
            height_request: 14,
            margin_top: 6,
        });
        box.append(this.progress);
        this.status = new Gtk.Label({
            label: t('Iniciando simulação…'),
            xalign: 0,
            css_classes: ['title-4'],
        });
        box.append(this.status);
        this.current = new Gtk.Label({
            xalign: 0,
            wrap: true,
            visible: false,
            css_classes: ['dim-label'],
        });
        box.append(this.current);

        const stats = new Gtk.Grid({
            column_spacing: 18,
            row_spacing: 8,
            margin_top: 8,
        });
        this.statsFiles = new Gtk.Label({xalign: 0});
        this.statsBytes = new Gtk.Label({xalign: 0});
        this.statsSpeed = new Gtk.Label({xalign: 0});
        this.statsDeletes = new Gtk.Label({xalign: 0});
        const addStat = (row, label, value) => {
            stats.attach(new Gtk.Label({
                label,
                xalign: 0,
                css_classes: ['dim-label'],
            }), 0, row, 1, 1);
            stats.attach(value, 1, row, 1, 1);
        };
        addStat(0, t('Files'), this.statsFiles);
        addStat(1, t('Data'), this.statsBytes);
        addStat(2, t('Speed / ETA'), this.statsSpeed);
        addStat(3, t('Deletes / errors'), this.statsDeletes);
        box.append(stats);
        this.result = new Gtk.Label({
            xalign: 0,
            wrap: true,
            visible: false,
            margin_top: 8,
        });
        box.append(this.result);
        toolbar.set_content(box);
        this.set_content(toolbar);
    }

    async _start() {
        this.running = true;
        this._unsubscribe = this.window.client.onSnapshot(json => {
            try {
                this._apply(JSON.parse(json));
            } catch (_) {
                // Ignore malformed snapshots.
            }
        });
        try {
            this.runId = await this.client.runJob(this.job.id, true, false);
        } catch (e) {
            this.running = false;
            this.status.set_text(t('Cannot start simulation: {message}',
                {message: e.message}));
        }
    }

    _apply(snapshot) {
        const job = (snapshot.jobs || []).find(item => item.id === this.job.id);
        if (!job)
            return;
        const state = job.state || {};
        if (state.dryRun)
            this.started = true;
        const progress = state.progress;
        if (progress) {
            this.lastProgress = progress;
            const percent = Number(progress.percent || 0);
            if (state.status === 'running' && percent > 0)
                this.progress.set_fraction(Math.max(0, Math.min(1, percent / 100)));
            else
                this.progress.pulse();
            this.status.set_text(state.status === 'checking' || !percent
                ? t('Checking the backup…')
                : `${Math.round(percent)}%`);
            this.current.set_text(progress.currentPath || progress.currentFile || '');
            this.current.visible = Boolean(this.current.get_text());
            this.statsFiles.set_text(
                `${progress.files || 0} / ${progress.totalFiles || 0}`);
            this.statsBytes.set_text(
                `${formatBytes(progress.bytes)} / ${formatBytes(progress.totalBytes)}`);
            this.statsSpeed.set_text(
                `${formatBytes(progress.speed)}/s · ETA ${formatEta(progress.eta)}`);
            this.statsDeletes.set_text(
                `${progress.deletes || 0} / ${progress.errors || 0}`);
        }
        if (this.started && this.running && !state.dryRun &&
            !['running', 'queued', 'checking', 'finalizing'].includes(state.status)) {
            this._finish(state);
        }
    }

    async _finish(state) {
        this.running = false;
        this.started = false;
        this.progress.set_fraction(1);
        try {
            const runs = await this.client.listRuns(this.job.id, 10);
            const run = runs.find(item => item.id === this.runId) || runs[0];
            if (run) {
                const stats = run.stats || {};
                this.statsFiles.set_text(
                    `${stats.transfers || 0} / ${stats.totalTransfers || 0}`);
                this.statsBytes.set_text(formatBytes(stats.bytes || 0));
                this.statsDeletes.set_text(
                    `${stats.deletes || 0} / ${stats.errors || 0}`);
                this.result.set_text(`${t(RESULT_LABELS[run.result] || run.result)}` +
                    (run.message ? `\n${run.message}` : ''));
                this.result.visible = true;
            } else {
                this.status.set_text(t('Simulation finished.'));
            }
        } catch (_) {
            this.status.set_text(t('Simulation finished.'));
        }
        this.status.set_text(state.message
            ? `${t('Simulation finished.')} · ${state.message}`
            : t('Simulation finished.'));
        this.cancelButton.visible = false;
        this.progress.set_fraction(1);
    }

    async _cancel() {
        if (this.running) {
            try {
                await this.client.cancelJob(this.job.id);
            } catch (_) {
                // Best effort.
            }
        }
        this.close();
    }

    _cleanup() {
        this._unsubscribe?.();
        this._unsubscribe = null;
        if (this.running) {
            this.client.cancelJob(this.job.id).catch(() => {});
            this.running = false;
        }
    }
});
