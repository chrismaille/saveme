import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {t} from '../src/i18n.js';

const STAGES = [
    'Validating settings',
    'Preparing the destination',
    'Writing the backup manifest',
    'Saving the job',
    'Finishing',
];

export const JobSaveDialog = GObject.registerClass({
    GTypeName: 'SaveMeJobSaveDialog',
}, class JobSaveDialog extends Adw.Window {
    constructor(parentWindow, jobName) {
        super({
            transient_for: parentWindow,
            modal: true,
            title: t('Saving job'),
            default_width: 560,
            default_height: 360,
        });
        this.window = parentWindow;
        this.stage = 0;
        this.finished = false;
        this.timer = 0;
        this.pulseTimer = 0;
        this._build(jobName);
    }

    _build(jobName) {
        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        header.set_title_widget(new Adw.WindowTitle({
            title: t('Saving job'),
            subtitle: jobName,
        }));
        toolbar.add_top_bar(header);

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 18,
            margin_bottom: 18,
            margin_start: 18,
            margin_end: 18,
        });
        this.status = new Gtk.Label({
            label: t('Saving…'),
            xalign: 0,
            css_classes: ['title-3'],
        });
        box.append(this.status);
        this.progress = new Gtk.ProgressBar({
            height_request: 8,
        });
        this.progress.pulse();
        box.append(this.progress);
        this.stepLabels = [];
        for (const stage of STAGES) {
            const row = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 8,
            });
            const icon = new Gtk.Image({
                icon_name: 'radio-symbolic',
                pixel_size: 14,
                css_classes: ['dim-label'],
            });
            const label = new Gtk.Label({
                label: t(stage),
                xalign: 0,
                css_classes: ['dim-label'],
            });
            row.append(icon);
            row.append(label);
            box.append(row);
            this.stepLabels.push({row, icon, label});
        }
        this.closeButton = new Gtk.Button({
            label: t('Close'),
            visible: false,
            halign: Gtk.Align.END,
        });
        this.closeButton.connect('clicked', () => this.close());
        box.append(this.closeButton);
        toolbar.set_content(box);
        this.set_content(toolbar);

        this._refreshStages();
        this.pulseTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            if (!this.finished)
                this.progress.pulse();
            return GLib.SOURCE_CONTINUE;
        });
        this.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
            if (this.finished)
                return GLib.SOURCE_REMOVE;
            this.stage = Math.min(this.stage + 1, STAGES.length - 1);
            this._refreshStages();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _refreshStages() {
        for (const [index, item] of this.stepLabels.entries()) {
            if (index < this.stage) {
                item.icon.icon_name = 'object-select-symbolic';
                item.icon.remove_css_class('dim-label');
                item.icon.add_css_class('success');
                item.label.remove_css_class('dim-label');
            } else if (index === this.stage && !this.finished) {
                item.icon.icon_name = 'emblem-synchronizing-symbolic';
                item.icon.remove_css_class('dim-label');
                item.icon.add_css_class('accent');
                item.label.remove_css_class('dim-label');
            } else {
                item.icon.icon_name = 'radio-symbolic';
                item.icon.add_css_class('dim-label');
                item.icon.remove_css_class('success');
                item.icon.remove_css_class('accent');
                item.label.add_css_class('dim-label');
            }
        }
        this.status.set_text(this.finished
            ? t('Job saved.')
            : t(STAGES[this.stage]));
    }

    complete() {
        this.finished = true;
        this.stage = STAGES.length;
        if (this.timer) {
            GLib.source_remove(this.timer);
            this.timer = 0;
        this.pulseTimer = 0;
        }
        this.progress.set_fraction(1);
        this.closeButton.visible = true;
        this._refreshStages();
    }

    fail(message) {
        this.finished = true;
        if (this.timer) {
            GLib.source_remove(this.timer);
            this.timer = 0;
        this.pulseTimer = 0;
        }
        this.progress.set_fraction(0);
        this.status.set_text(message);
        this.closeButton.visible = true;
    }

    close(...args) {
        if (this.timer) {
            GLib.source_remove(this.timer);
            this.timer = 0;
        this.pulseTimer = 0;
        }
        return super.close(...args);
    }
});
