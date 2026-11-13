import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {
    jobDetail,
    progressView,
    statusIconName,
    statusLabel,
} from '../presentation.js';
import {ProgressBar} from './progress-bar.js';

export class JobRow {
    constructor(extension, job) {
        this.extension = extension;
        this.job = job;
        this.item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            activate: false,
            hover: false,
        });

        this.box = new St.BoxLayout({vertical: true, style_class: 'saveme-job-row'});
        this.item.add_child(this.box);

        this.top = new St.BoxLayout({vertical: false, style_class: 'saveme-job-top'});
        this.statusIcon = new St.Icon({
            icon_name: 'emblem-ok-symbolic',
            icon_size: 16,
            style_class: 'saveme-status-icon saveme-status-idle',
        });
        this.name = new St.Label({text: job.name, style_class: 'saveme-job-name', x_expand: true});
        this.status = new St.Label({text: '', style_class: 'saveme-job-status'});
        this.top.add_child(this.statusIcon);
        this.top.add_child(this.name);
        this.top.add_child(this.status);
        this.box.add_child(this.top);

        this.detail = new St.Label({text: '', style_class: 'saveme-job-detail'});
        this.box.add_child(this.detail);

        this.progressBar = new ProgressBar();
        this.box.add_child(this.progressBar.area);

        this.fileLabel = new St.Label({
            text: '',
            style_class: 'saveme-job-file',
        });
        this.box.add_child(this.fileLabel);

        this.progress = new St.Label({text: '', style_class: 'saveme-job-detail'});
        this.box.add_child(this.progress);

        this.actions = new St.BoxLayout({vertical: false, style_class: 'saveme-actions'});
        this.runButton = this._button('media-playback-start-symbolic', _('Run now'), () => {
            extension.runJob(job.id);
        });
        this.pauseButton = this._button('media-playback-pause-symbolic', _('Pause'), () => {
            extension.pauseJob(job.id, !this.job.state?.paused);
        });
        this.cancelButton = this._button('process-stop-symbolic', _('Stop and pause'), () => {
            extension.cancelJob(job.id);
        });
        this.logsButton = this._button('document-open-symbolic', _('Logs'), () => {
            extension.openLogs(job.id);
        });
        this.actions.add_child(this.runButton);
        this.actions.add_child(this.pauseButton);
        this.actions.add_child(this.cancelButton);
        this.actions.add_child(this.logsButton);
        this.box.add_child(this.actions);

        this.update(job);
    }

    _button(iconName, tooltip, callback) {
        const button = new St.Button({
            style_class: 'saveme-action-button',
            can_focus: false,
            child: new St.Icon({
                icon_name: iconName,
                style_class: 'popup-menu-icon',
            }),
        });
        button.accessible_name = tooltip;
        button.connect('clicked', callback);
        return button;
    }

    _setStatusIcon(status) {
        this.statusIcon.icon_name = statusIconName(status);
        this.statusIcon.style_class =
            `saveme-status-icon saveme-status-${status}`;
    }

    update(job) {
        this.job = job;
        const state = job.state || {};
        const status = state.status || 'idle';
        this.name.text = job.name || job.id;
        this.status.text = statusLabel(status);
        this._setStatusIcon(status);
        this.detail.text = jobDetail(job, {translate: _});

        const progress = progressView(state);
        this.progress.text = progress.text;
        this.progress.visible = progress.visible;
        this.fileLabel.text = progress.file;
        this.fileLabel.visible = Boolean(progress.file);
        this.progressBar.area.visible = progress.showBar;
        this.progressBar.setPercent(progress.percent);

        const running = status === 'running';
        const paused = Boolean(state.paused);
        this.runButton.visible = !running && job.enabled;
        this.pauseButton.visible = job.enabled;
        const pauseIcon = paused
            ? 'media-playback-start-symbolic'
            : 'media-playback-pause-symbolic';
        if (this.pauseButton.child.icon_name !== pauseIcon)
            this.pauseButton.child.icon_name = pauseIcon;
        this.pauseButton.accessible_name = paused ? _('Resume') : _('Pause');
        this.cancelButton.visible = running;
        this.logsButton.visible = true;
    }
}
