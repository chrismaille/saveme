import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {t} from '../src/i18n.js';
import {
    RESULT_LABELS,
    formatDateTime,
    formatWhen,
} from './presentation/format.js';

export const JobLogsDialog = GObject.registerClass({
    GTypeName: 'SaveMeJobLogsDialog',
}, class JobLogsDialog extends Adw.Window {
    constructor(parentWindow, job) {
        super({
            transient_for: parentWindow,
            modal: true,
            title: t('Logs — {name}', {name: job.name || job.id}),
            default_width: 920,
            default_height: 720,
        });
        this.window = parentWindow;
        this.client = parentWindow.client;
        this.job = job;
        this.runs = [];
        this.rawLog = '';
        this._build();
        this.reload();
    }

    _build() {
        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        header.set_title_widget(new Adw.WindowTitle({
            title: t('Logs'),
            subtitle: this.job.name || this.job.id,
        }));
        const close = new Gtk.Button({label: t('Close')});
        close.connect('clicked', () => this.close());
        header.pack_start(close);
        this.refreshButton = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: t('Refresh'),
            css_classes: ['flat'],
        });
        this.refreshButton.connect('clicked', () => this.reload());
        header.pack_end(this.refreshButton);
        toolbar.add_top_bar(header);

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 10,
            margin_top: 10,
            margin_bottom: 10,
            margin_start: 12,
            margin_end: 12,
        });
        this.runRow = new Adw.ComboRow({
            title: t('Run'),
            model: Gtk.StringList.new([t('No runs yet')]),
        });
        this.runRow.connect('notify::selected', () => this._loadSelectedRun());
        box.append(this.runRow);

        const searchBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
        });
        this.search = new Gtk.SearchEntry({
            placeholder_text: t('Search in this log…'),
            hexpand: true,
        });
        this.search.connect('search-changed', () => this._renderLog());
        this.status = new Gtk.Label({
            xalign: 0,
            css_classes: ['dim-label'],
        });
        searchBox.append(this.search);
        searchBox.append(this.status);
        box.append(searchBox);

        this.textView = new Gtk.TextView({
            editable: false,
            monospace: true,
            wrap_mode: Gtk.WrapMode.WORD_CHAR,
            left_margin: 8,
            right_margin: 8,
            top_margin: 8,
            bottom_margin: 8,
        });
        this.textView.add_css_class('saveme-log-view');
        this.buffer = this.textView.get_buffer();
        const scrolled = new Gtk.ScrolledWindow({vexpand: true, hexpand: true});
        scrolled.set_child(this.textView);
        box.append(scrolled);
        toolbar.set_content(box);
        this.set_content(toolbar);
    }

    async reload() {
        this.refreshButton.sensitive = false;
        try {
            this.runs = await this.client.listRuns(this.job.id, 100);
            const labels = this.runs.map(run => {
                const result = t(RESULT_LABELS[run.result] || run.result || '-');
                return `${formatWhen(run.startedAt)} · ${result}`;
            });
            this.runRow.model = Gtk.StringList.new(
                labels.length ? labels : [t('No runs yet')]);
            this.runRow.selected = 0;
            if (this.runs.length)
                await this._loadSelectedRun();
            else
                this._setLog(t('Run the job to see results here.'));
        } catch (e) {
            this._setLog(t('Cannot load runs: {message}', {message: e.message}));
        } finally {
            this.refreshButton.sensitive = true;
        }
    }

    async _loadSelectedRun() {
        const run = this.runs[this.runRow.selected];
        if (!run)
            return;
        try {
            this.rawLog = await this.client.getRunLog(this.job.id, run.id);
            this._renderLog(run);
        } catch (e) {
            this._setLog(t('Cannot load log: {message}', {message: e.message}));
        }
    }

    _renderLog(run = null) {
        const needle = this.search.text.trim().toLocaleLowerCase();
        const lines = String(this.rawLog || '').split('\n');
        const selected = needle
            ? lines.filter(line => line.toLocaleLowerCase().includes(needle))
            : lines;
        this._setLog(selected.join('\n'));
        if (run) {
            this.status.set_text(`${formatDateTime(run.startedAt)} · ` +
                `${lines.length} ${t('lines')}` +
                (needle ? ` · ${selected.length} ${t('matches')}` : ''));
        } else {
            this.status.set_text(`${lines.length} ${t('lines')}`);
        }
    }

    _setLog(text) {
        this.buffer.set_text(String(text || ''), -1);
    }
});
