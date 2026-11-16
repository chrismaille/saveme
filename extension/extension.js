import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {SaveMeDaemonClient} from './daemon-client.js';
import {SystemLauncher} from './system-launcher.js';
import {JobRow} from './ui/job-row.js';
import {displayStatus} from './presentation.js';
import {t} from './i18n.js';

export default class SaveMeExtension extends Extension {
    enable() {
        this._snapshot = null;
        this._daemonError = null;
        this._rows = new Map();
        this._jobsKey = null;
        this._refreshTimer = 0;
        this._launcher = new SystemLauncher();

        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);
        this._idleIcon = Gio.icon_new_for_string(`${this.path}/icons/saveme-symbolic.svg`);
        this._panelIcon = new St.Icon({
            gicon: this._idleIcon,
            style_class: 'system-status-icon',
        });
        this._panelIconKey = null;
        this._panelSpin = null;
        this._pauseAllKey = null;
        this._indicator.add_child(this._panelIcon);
        this._indicator.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._stopPanelAnimation();
                this._panelIconKey = null;
                this._refresh();
            } else {
                this._updatePanelIcon();
            }
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._buildMenu();
        this._setFixedWidth(380);

        this._daemonClient = new SaveMeDaemonClient({
            onSnapshot: json => this._applySnapshot(json),
            onError: message => this._setDaemonError(message),
            onAfterCall: () => this._scheduleRefresh(),
        });
        this._daemonClient.connect();
    }

    disable() {
        if (this._refreshTimer) {
            GLib.source_remove(this._refreshTimer);
            this._refreshTimer = 0;
        }
        this._stopPanelAnimation();
        this._daemonClient?.disconnect();
        this._daemonClient = null;
        this._rows?.clear();
        this._rows = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._snapshot = null;
    }

    _setFixedWidth(width) {
        const actor = this._indicator?.menu?.actor;
        if (actor)
            actor.set_width(width);
    }

    _buildMenu() {
        const menu = this._indicator.menu;
        menu.removeAll();

        this._header = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            activate: false,
            hover: false,
        });
        const headerBox = new St.BoxLayout({vertical: false, style_class: 'saveme-header'});
        const title = new St.Label({
            text: 'SaveMe',
            style_class: 'saveme-title',
            x_expand: true,
        });
        headerBox.add_child(title);
        this._header.add_child(headerBox);
        menu.addMenuItem(this._header);

        this._jobsSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._jobsSection);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._footer = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            activate: false,
            hover: false,
        });
        const footerBox = new St.BoxLayout({vertical: false, style_class: 'saveme-footer'});
        this._openAppButton = this._footerButton(
            'preferences-system-symbolic', t('Open SaveMe'),
            () => this.openSettings());
        this._pauseAllButton = this._footerButton(
            'media-playback-pause-symbolic', t('Pause all'),
            () => this._togglePauseAll());
        this._pauseAllIcon = this._pauseAllButton.child.get_first_child();
        this._pauseAllLabel = this._pauseAllIcon.get_next_sibling();
        footerBox.add_child(this._openAppButton);
        footerBox.add_child(this._pauseAllButton);
        this._footer.add_child(footerBox);
        menu.addMenuItem(this._footer);
    }

    _footerButton(iconName, label, callback) {
        const content = new St.BoxLayout({vertical: false, style_class: 'saveme-footer-content'});
        content.add_child(new St.Icon({
            icon_name: iconName,
            style_class: 'popup-menu-icon',
        }));
        content.add_child(new St.Label({text: label}));
        const button = new St.Button({
            style_class: 'saveme-footer-button',
            can_focus: false,
            x_expand: true,
            child: content,
        });
        button.accessible_name = label;
        button.connect('clicked', callback);
        return button;
    }

    _updatePanelIcon() {
        if (!this._panelIcon)
            return;
        // Changing the panel icon while the popup is open can make GNOME
        // Shell close the menu. Update it when the menu is closed instead.
        if (this._indicator?.menu?.isOpen)
            return;
        let key = 'idle';
        if (this._daemonError) {
            key = 'unavailable';
        } else {
            const jobs = this._snapshot?.jobs || [];
            const statuses = jobs.map(job => displayStatus(job.state?.status,
                job.state?.progress?.phase));
            if (statuses.some(status => ['error', 'needs-auth', 'delete-guard']
                .includes(status))) {
                key = 'error';
            } else if (statuses.some(status =>
                ['running', 'checking', 'finalizing'].includes(status))) {
                key = 'running';
            } else if (statuses.includes('queued')) {
                key = 'queued';
            } else if (statuses.includes('stopped')) {
                key = 'stopped';
            } else if (this._snapshot?.pausedAll || statuses.includes('paused')) {
                key = 'paused';
            } else if (statuses.some(status =>
                ['waiting-source', 'waiting-destination', 'waiting-idle', 'offline']
                    .includes(status))) {
                key = 'waiting';
            }
        }
        if (key === this._panelIconKey)
            return;
        this._panelIconKey = key;
        const icons = {
            'unavailable': 'dialog-warning-symbolic',
            'error': 'dialog-error-symbolic',
            'running': 'emblem-synchronizing-symbolic',
            'queued': 'appointment-soon-symbolic',
            'stopped': 'media-playback-stop-symbolic',
            'paused': 'media-playback-pause-symbolic',
            'waiting': 'dialog-warning-symbolic',
        };
        if (key === 'idle') {
            this._panelIcon.icon_name = null;
            this._panelIcon.gicon = this._idleIcon;
        } else {
            this._panelIcon.gicon = null;
            this._panelIcon.icon_name = icons[key];
        }
        this._panelIcon.accessible_name = `SaveMe: ${key}`;
        this._setPanelAnimation(key === 'running');
    }

    _startPanelAnimation() {
        if (!this._panelIcon || this._panelSpin || this._indicator?.menu?.isOpen)
            return;
        const spin = new Clutter.PropertyTransition({
            property_name: 'rotation-angle-z',
            duration: 1400,
            repeat_count: -1,
            progress_mode: Clutter.AnimationMode.LINEAR,
        });
        spin.set_from(0);
        spin.set_to(360);
        this._panelIcon.add_transition('saveme-panel-spin', spin);
        this._panelSpin = spin;
    }

    _stopPanelAnimation() {
        if (!this._panelIcon || !this._panelSpin)
            return;
        this._panelIcon.remove_transition('saveme-panel-spin');
        this._panelIcon.rotation_angle_z = 0;
        this._panelSpin = null;
    }

    _setPanelAnimation(active) {
        if (active)
            this._startPanelAnimation();
        else
            this._stopPanelAnimation();
    }

    _refresh() {
        this._daemonClient?.refresh();
    }

    _scheduleRefresh() {
        if (!this._indicator || this._refreshTimer)
            return;
        this._refreshTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._refreshTimer = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _applySnapshot(json) {
        if (!this._indicator)
            return;
        try {
            this._snapshot = JSON.parse(json);
            this._daemonError = null;
        } catch (_) {
            this._setDaemonError(t('Invalid daemon response'));
            return;
        }
        this._render();
    }

    _setDaemonError(message) {
        this._daemonClient?.invalidateSnapshot();
        this._daemonError = message;
        this._snapshot = null;
        this._render();
    }

    _render() {
        if (!this._indicator || !this._jobsSection)
            return;
        const pausedAll = Boolean(this._snapshot?.pausedAll);
        this._updatePanelIcon();
        const pauseAllKey = pausedAll ? 'resume' : 'pause';
        if (this._pauseAllKey !== pauseAllKey) {
            this._pauseAllKey = pauseAllKey;
            this._pauseAllIcon.icon_name = pausedAll
                ? 'media-playback-start-symbolic'
                : 'media-playback-pause-symbolic';
            const label = pausedAll ? t('Resume all') : t('Pause all');
            this._pauseAllLabel.text = label;
            this._pauseAllButton.accessible_name = label;
        }

        if (this._daemonError) {
            this._jobsSection.removeAll();
            this._rows.clear();
            this._jobsKey = null;
            const item = new PopupMenu.PopupBaseMenuItem({
                reactive: false, activate: false, hover: false,
            });
            const box = new St.BoxLayout({vertical: true, style_class: 'saveme-empty'});
            box.add_child(new St.Label({text: t('SaveMe daemon is not available')}));
            const detail = new St.Label({
                text: this._daemonError,
                style_class: 'saveme-job-detail',
            });
            box.add_child(detail);
            item.add_child(box);
            this._jobsSection.addMenuItem(item);
            return;
        }

        const allJobs = this._snapshot?.jobs || [];
        const jobs = allJobs.filter(job => {
            const display = displayStatus(job.state?.status, job.state?.progress?.phase);
            return !job.draft && !['idle', 'disabled'].includes(display);
        });
        const key = jobs.map(job => `${job.id}:${job.name}`).join('|');
        if (key !== this._jobsKey) {
            this._jobsKey = key;
            this._jobsSection.removeAll();
            this._rows.clear();
            for (const job of jobs) {
                const row = new JobRow(this, job);
                this._rows.set(job.id, row);
                this._jobsSection.addMenuItem(row.item);
            }
            if (jobs.length === 0) {
                const item = new PopupMenu.PopupBaseMenuItem({
                    reactive: false, activate: false, hover: false,
                });
                const box = new St.BoxLayout({vertical: true, style_class: 'saveme-empty'});
                box.add_child(new St.Label({text: t('No active jobs')}));
                item.add_child(box);
                this._jobsSection.addMenuItem(item);
            }
        } else {
            for (const job of jobs)
                this._rows.get(job.id)?.update(job);
        }
    }

    runJob(jobId) {
        this._daemonClient?.runJob(jobId);
    }

    playJob(jobId) {
        this._daemonClient?.playJob(jobId);
    }

    cancelJob(jobId) {
        this._daemonClient?.cancelJob(jobId);
    }

    pauseJob(jobId, paused) {
        this._daemonClient?.pauseJob(jobId, paused);
    }

    _togglePauseAll() {
        const paused = !this._snapshot?.pausedAll;
        this._daemonClient?.pauseAll(paused);
    }

    _openApp(args) {
        try {
            const program = this._launcher.find('saveme-settings');
            if (!program) {
                Main.notify('SaveMe', t('SaveMe Settings is not installed'));
                return;
            }
            this._launcher.spawn([program, ...args]);
        } catch (e) {
            Main.notify('SaveMe', e.message);
        }
    }

    openSettings() {
        this._openApp([]);
    }

    openLogs(jobId) {
        const args = ['--view', 'logs'];
        if (jobId)
            args.push('--job', jobId);
        this._openApp(args);
    }

    openDebug() {
        this._openApp(['--view', 'debug']);
    }
}
