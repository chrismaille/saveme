import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {
    displayStatus,
    progressView,
    statusDetail,
    statusIconName,
    statusLabel,
    typeLabel,
} from '../presentation.js';
import {ProgressBar} from './progress-bar.js';
import {t} from '../i18n.js';

export class JobRow {
    constructor(extension, job) {
        this.extension = extension;
        this.job = job;
        this.item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            activate: false,
            hover: false,
        });

        this.box = new St.BoxLayout({
            vertical: true,
            style_class: 'saveme-job-row',
            x_expand: true,
        });
        this.item.add_child(this.box);

        this.top = new St.BoxLayout({vertical: false, style_class: 'saveme-job-top'});
        this.statusIcon = new St.Icon({
            icon_name: 'emblem-ok-symbolic',
            icon_size: 16,
            style_class: 'saveme-status-icon saveme-status-idle',
        });
        this._statusSpin = null;
        this.name = new St.Label({text: job.name, style_class: 'saveme-job-name', x_expand: true});
        this.name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.top.add_child(this.statusIcon);
        this.top.add_child(this.name);
        this.box.add_child(this.top);

        this.meta = new St.Label({text: '', style_class: 'saveme-job-meta'});
        this.meta.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.box.add_child(this.meta);

        this.detail = new St.Label({text: '', style_class: 'saveme-job-detail'});
        this.detail.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.box.add_child(this.detail);

        this.progressBar = new ProgressBar();
        this.box.add_child(this.progressBar.area);

        this.fileLabel = new St.Label({
            text: '',
            style_class: 'saveme-job-file',
        });
        this.box.add_child(this.fileLabel);

        this.progress = new St.Label({text: '', style_class: 'saveme-job-progress-text'});
        this.box.add_child(this.progress);

        this.actions = new St.BoxLayout({vertical: false, style_class: 'saveme-actions'});
        this.runButton = this._button('media-playback-start-symbolic', t('Play'), () => {
            extension.playJob(job.id);
        });
        this.pauseButton = this._button('media-playback-pause-symbolic', t('Pause'), () => {
            extension.pauseJob(job.id, true);
        });
        this.cancelButton = this._button('media-playback-stop-symbolic', t('Stop'), () => {
            extension.cancelJob(job.id);
        });
        this.cancelButton.add_style_class_name('saveme-stop-button');
        this.actions.add_child(this.runButton);
        this.actions.add_child(this.pauseButton);
        this.actions.add_child(this.cancelButton);
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
        const active = ['running', 'checking', 'finalizing'].includes(status);
        if (active)
            this._startSpin();
        else
            this._stopSpin();
    }

    _startSpin() {
        if (this._statusSpin)
            return;
        const spin = new Clutter.PropertyTransition({
            property_name: 'rotation-angle-z',
            duration: 1400,
            repeat_count: -1,
            progress_mode: Clutter.AnimationMode.LINEAR,
        });
        spin.set_from(0);
        spin.set_to(360);
        this.statusIcon.add_transition('saveme-status-spin', spin);
        this._statusSpin = spin;
    }

    _stopSpin() {
        if (!this._statusSpin)
            return;
        this.statusIcon.remove_transition('saveme-status-spin');
        this.statusIcon.rotation_angle_z = 0;
        this._statusSpin = null;
    }

    update(job) {
        this.job = job;
        const state = job.state || {};
        const display = displayStatus(state.status, state.progress?.phase);
        this.name.text = job.name || job.id;
        this.meta.text = `${typeLabel(job.type, t)} · ${statusLabel(display, t)}`;
        this.meta.style_class = `saveme-job-meta saveme-status-${display}`;
        this._setStatusIcon(display);
        this.detail.text = statusDetail(job, {translate: t});

        const progress = progressView(state, {translate: t});
        this.progress.text = progress.text;
        this.progress.visible = progress.visible && Boolean(progress.text);
        this.fileLabel.text = progress.file;
        this.fileLabel.visible = Boolean(progress.file);
        this.progressBar.area.visible = progress.showBar;
        this.progressBar.setPercent(progress.percent);

        const running = ['running', 'checking', 'finalizing', 'queued']
            .includes(display);
        const paused = Boolean(state.paused);
        const stopped = Boolean(state.stopped);
        const enabled = job.enabled !== false;
        this.runButton.visible = enabled && !running;
        this.pauseButton.visible = enabled && !paused && !stopped;
        this.cancelButton.visible = !stopped;
    }
}
