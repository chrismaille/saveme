import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {t} from '../src/i18n.js';

const SAVE_STAGES = [
    'Validating settings',
    'Preparing the destination',
    'Writing the backup manifest',
    'Saving the job',
    'Finishing',
];

const IMPORT_STAGES = [
    'Validating job',
    'Writing the job manifest',
    'Updating the job list',
    'Finishing',
];

const RESTORE_STAGES = [
    'Validating job',
    'Preparing the temporary job',
    'Opening restore',
    'Finishing',
];

export const JobSaveDialog = GObject.registerClass({
    GTypeName: 'SaveMeJobSaveDialog',
}, class JobSaveDialog extends Adw.Window {
    constructor(parentWindow, jobName, {mode = 'save'} = {}) {
        const importMode = mode === 'import';
        const restoreMode = mode === 'restore';
        const slowMode = importMode || restoreMode;
        const title = restoreMode ? t('Preparing restore')
            : importMode ? t('Importing job') : t('Saving job');
        super({
            transient_for: parentWindow,
            modal: true,
            title,
            default_width: 560,
            default_height: slowMode ? 320 : 360,
        });
        this.window = parentWindow;
        this.titleText = title;
        this.importMode = importMode;
        this.restoreMode = restoreMode;
        this.slowMode = slowMode;
        this.busyText = restoreMode ? t('Preparing…')
            : importMode ? t('Importing…') : t('Saving…');
        this.doneText = restoreMode ? t('Restore ready.')
            : importMode ? t('Job imported.') : t('Job saved.');
        this.stages = restoreMode ? RESTORE_STAGES
            : importMode ? IMPORT_STAGES : SAVE_STAGES;
        // Importing and restoring are single daemon calls. Show the stage
        // that is actually in progress instead of pretending to advance.
        this.stage = slowMode ? 1 : 0;
        this.finished = false;
        this.failed = false;
        this.failureMessage = '';
        this.timer = 0;
        this.pulseTimer = 0;
        this._build(jobName);
    }

    _build(jobName) {
        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        header.set_title_widget(new Adw.WindowTitle({
            title: this.titleText,
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
            label: this.busyText,
            xalign: 0,
            wrap: true,
            max_width_chars: 54,
            css_classes: ['title-3'],
        });
        box.append(this.status);
        this.progress = new Gtk.ProgressBar({
            height_request: 8,
        });
        this.progress.pulse();
        box.append(this.progress);
        if (this.slowMode) {
            box.append(new Gtk.Label({
                label: t('Cloud destinations can take a few seconds.'),
                xalign: 0,
                wrap: true,
                css_classes: ['dim-label'],
            }));
        }
        this.stepLabels = [];
        for (const stage of this.stages) {
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
        if (!this.slowMode) {
            this.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
                if (this.finished)
                    return GLib.SOURCE_REMOVE;
                this.setStage(this.stage + 1);
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    _refreshStages() {
        for (const [index, item] of this.stepLabels.entries()) {
            if (this.failed && index === this.stage) {
                item.icon.icon_name = 'dialog-error-symbolic';
                item.icon.remove_css_class('dim-label');
                item.icon.add_css_class('error');
                item.label.remove_css_class('dim-label');
            } else if (index < this.stage) {
                item.icon.icon_name = 'object-select-symbolic';
                item.icon.remove_css_class('dim-label');
                item.icon.remove_css_class('error');
                item.icon.add_css_class('success');
                item.label.remove_css_class('dim-label');
            } else if (index === this.stage && !this.finished) {
                item.icon.icon_name = 'emblem-synchronizing-symbolic';
                item.icon.remove_css_class('dim-label');
                item.icon.remove_css_class('error');
                item.icon.add_css_class('accent');
                item.label.remove_css_class('dim-label');
            } else {
                item.icon.icon_name = 'radio-symbolic';
                item.icon.add_css_class('dim-label');
                item.icon.remove_css_class('success');
                item.icon.remove_css_class('accent');
                item.icon.remove_css_class('error');
                item.label.add_css_class('dim-label');
            }
        }
        let message;
        if (this.failed)
            message = this.failureMessage;
        else if (this.finished)
            message = this.doneText;
        else
            message = t(this.stages[this.stage] || this.busyText);
        this.status.set_text(message);
    }

    setStage(index) {
        if (this.finished)
            return;
        this.stage = Math.max(0, Math.min(this.stages.length - 1, index));
        this._refreshStages();
    }

    complete() {
        this.finished = true;
        this.stage = this.stages.length;
        this._stopTimers();
        this.progress.set_fraction(1);
        this.closeButton.visible = true;
        this._refreshStages();
    }

    fail(message) {
        this.finished = true;
        this.failed = true;
        this.failureMessage = message;
        this._stopTimers();
        this.progress.set_fraction(0);
        this.closeButton.visible = true;
        this._refreshStages();
    }

    _stopTimers() {
        if (this.timer) {
            GLib.source_remove(this.timer);
            this.timer = 0;
        }
        if (this.pulseTimer) {
            GLib.source_remove(this.pulseTimer);
            this.pulseTimer = 0;
        }
    }

    close(...args) {
        this._stopTimers();
        return super.close(...args);
    }
});
