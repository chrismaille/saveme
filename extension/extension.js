import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const DAEMON_BUS_NAME = 'io.github.chrismaille.SaveMe.Daemon';
const DAEMON_OBJECT_PATH = '/io/github/chrismaille/SaveMe/Daemon';
const DAEMON_INTERFACE = 'io.github.chrismaille.SaveMe.Daemon';

const STATUS_LABELS = {
    'idle': 'Idle',
    'running': 'Running',
    'paused': 'Paused',
    'waiting-source': 'Source missing',
    'waiting-destination': 'Destination missing',
    'offline': 'Offline',
    'error': 'Error',
    'needs-auth': 'Needs authentication',
    'delete-guard': 'Deleting blocked',
    'disabled': 'Disabled',
};

function formatBytes(value) {
    let n = Number(value) || 0;
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let unit = 0;
    while (n >= 1024 && unit < units.length - 1) {
        n /= 1024;
        unit++;
    }
    return `${n.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatWhen(iso) {
    if (!iso)
        return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime()))
        return '';
    const diff = Date.now() - date.getTime();
    if (diff < 60_000)
        return _('just now');
    if (diff < 3_600_000)
        return `${Math.floor(diff / 60_000)} min`;
    if (diff < 86_400_000)
        return `${Math.floor(diff / 3_600_000)} h`;
    return `${Math.floor(diff / 86_400_000)} d`;
}

function shortFile(path, max = 42) {
    if (!path)
        return '';
    const name = GLib.path_get_basename(String(path));
    return name.length <= max ? name : `${name.slice(0, max - 1)}…`;
}

function formatEta(value) {
    const total = Number(value);
    if (!Number.isFinite(total) || total < 0)
        return '-';
    const seconds = Math.round(total);
    if (seconds < 60)
        return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
}

class ProgressBar {
    constructor() {
        this.percent = 0;
        this.area = new St.DrawingArea({
            style_class: 'saveme-progress',
            x_expand: true,
        });
        this.area.connect('repaint', () => this._draw());
    }

    setPercent(value) {
        this.percent = Math.max(0, Math.min(100, Number(value) || 0));
        this.area.queue_repaint();
    }

    _draw() {
        const cr = this.area.get_context();
        const [width, height] = this.area.get_surface_size();
        cr.setSourceRGBA(1, 1, 1, 0.14);
        cr.rectangle(0, 0, width, height);
        cr.fill();
        if (this.percent > 0) {
            cr.setSourceRGBA(0.26, 0.52, 0.89, 1);
            cr.rectangle(0, 0, width * this.percent / 100, height);
            cr.fill();
        }
    }
}

class JobRow {
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
        const icons = {
            'idle': 'emblem-ok-symbolic',
            'running': 'emblem-synchronizing-symbolic',
            'paused': 'media-playback-pause-symbolic',
            'disabled': 'media-playback-pause-symbolic',
            'waiting-source': 'dialog-warning-symbolic',
            'waiting-destination': 'dialog-warning-symbolic',
            'offline': 'dialog-warning-symbolic',
            'error': 'dialog-error-symbolic',
            'needs-auth': 'dialog-error-symbolic',
            'delete-guard': 'dialog-error-symbolic',
        };
        this.statusIcon.icon_name = icons[status] || 'emblem-ok-symbolic';
        this.statusIcon.style_class =
            `saveme-status-icon saveme-status-${status}`;
    }

    update(job) {
        this.job = job;
        const state = job.state || {};
        const status = state.status || 'idle';
        this.name.text = job.name || job.id;
        this.status.text = STATUS_LABELS[status] || status;
        this._setStatusIcon(status);

        let detail = job.type === 'backup' ? _('Backup') : _('Sync');
        if (state.lastRunAt)
            detail += ` · ${_('last run')} ${formatWhen(state.lastRunAt)}`;
        if (state.lastResult)
            detail += ` · ${state.lastResult}`;
        this.detail.text = detail;

        if (state.status === 'running' && state.progress) {
            const p = state.progress;
            const percent = Number(p.percent || 0).toFixed(0);
            let text = `${percent}% · ${formatBytes(p.bytes)}`;
            if (p.totalBytes)
                text += ` / ${formatBytes(p.totalBytes)}`;
            if (p.eta !== null && p.eta !== undefined)
                text += ` · ETA ${formatEta(p.eta)}`;
            const file = shortFile(p.currentFile);
            if (file)
                text += ` · ${file}`;
            this.progress.text = text;
            this.progress.visible = true;
            this.progressBar.area.visible = true;
            this.progressBar.setPercent(p.percent || 0);
        } else if (state.message) {
            this.progress.text = state.message;
            this.progress.visible = true;
            this.progressBar.area.visible = false;
        } else {
            this.progress.text = '';
            this.progress.visible = false;
            this.progressBar.area.visible = false;
        }

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

export default class SaveMeExtension extends Extension {
    enable() {
        this._bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
        this._snapshot = null;
        this._snapshotJson = null;
        this._daemonError = null;
        this._rows = new Map();
        this._jobsKey = null;
        this._signalId = 0;

        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);
        this._idleIcon = Gio.icon_new_for_string(`${this.path}/icons/saveme-symbolic.svg`);
        this._panelIcon = new St.Icon({
            gicon: this._idleIcon,
            style_class: 'system-status-icon',
        });
        this._panelIconKey = null;
        this._pauseAllKey = null;
        this._indicator.add_child(this._panelIcon);
        this._indicator.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._refresh();
            else
                this._updatePanelIcon();
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._buildMenu();
        this._signalId = this._bus.signal_subscribe(
            DAEMON_BUS_NAME,
            DAEMON_INTERFACE,
            'SnapshotChanged',
            DAEMON_OBJECT_PATH,
            null,
            Gio.DBusSignalFlags.NONE,
            (_connection, _sender, _path, _iface, _signal, params) => {
                try {
                    const [json] = params.deepUnpack();
                    this._applySnapshot(json);
                } catch (e) {
                    logError(e, 'SaveMe: invalid snapshot signal');
                }
            });
        this._refresh();
    }

    disable() {
        if (this._signalId) {
            try {
                this._bus.signal_unsubscribe(this._signalId);
            } catch (_) {
                // Ignore.
            }
            this._signalId = 0;
        }
        this._rows?.clear();
        this._rows = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._snapshot = null;
        this._snapshotJson = null;
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
        this._pauseAllButton = new St.Button({
            style_class: 'saveme-action-button',
            can_focus: false,
            child: new St.Icon({
                icon_name: 'media-playback-pause-symbolic',
                style_class: 'popup-menu-icon',
            }),
        });
        this._pauseAllButton.accessible_name = _('Pause all');
        this._pauseAllButton.connect('clicked', () => this._togglePauseAll());
        headerBox.add_child(title);
        headerBox.add_child(this._pauseAllButton);
        this._header.add_child(headerBox);
        menu.addMenuItem(this._header);

        this._jobsSection = new PopupMenu.PopupMenuSection();
        menu.addMenuItem(this._jobsSection);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const settingsItem = new PopupMenu.PopupMenuItem(_('Settings'));
        settingsItem.connect('activate', () => this.openSettings());
        menu.addMenuItem(settingsItem);
        const logsItem = new PopupMenu.PopupMenuItem(_('Logs'));
        logsItem.connect('activate', () => this.openLogs(null));
        menu.addMenuItem(logsItem);
        const debugItem = new PopupMenu.PopupMenuItem(_('Debug'));
        debugItem.connect('activate', () => this.openDebug());
        menu.addMenuItem(debugItem);
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
            if (jobs.some(job => ['error', 'needs-auth', 'delete-guard']
                .includes(job.state?.status))) {
                key = 'error';
            } else if (jobs.some(job => job.state?.status === 'running')) {
                key = 'running';
            } else if (this._snapshot?.pausedAll ||
                jobs.some(job => job.state?.status === 'paused')) {
                key = 'paused';
            } else if (jobs.some(job => ['waiting-source', 'waiting-destination', 'offline']
                .includes(job.state?.status))) {
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
    }

    _call(method, params, callback = null) {
        if (!this._bus)
            return;
        this._bus.call(
            DAEMON_BUS_NAME,
            DAEMON_OBJECT_PATH,
            DAEMON_INTERFACE,
            method,
            params,
            null,
            Gio.DBusCallFlags.NONE,
            5000,
            null,
            (connection, result) => {
                try {
                    const reply = connection.call_finish(result);
                    callback?.(reply);
                    this._scheduleRefresh();
                } catch (e) {
                    this._setDaemonError(e.message);
                }
            });
    }

    _refresh() {
        this._call('GetSnapshot', null, reply => {
            const [json] = reply.deepUnpack();
            this._applySnapshot(json);
        });
    }

    _scheduleRefresh() {
        if (!this._indicator)
            return;
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _applySnapshot(json) {
        if (!this._indicator)
            return;
        if (json === this._snapshotJson)
            return;
        this._snapshotJson = json;
        try {
            this._snapshot = JSON.parse(json);
            this._daemonError = null;
        } catch (e) {
            this._setDaemonError(_('Invalid daemon response'));
            return;
        }
        this._render();
    }

    _setDaemonError(message) {
        this._daemonError = message;
        this._snapshot = null;
        this._snapshotJson = null;
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
            this._pauseAllButton.child.icon_name = pausedAll
                ? 'media-playback-start-symbolic'
                : 'media-playback-pause-symbolic';
            this._pauseAllButton.accessible_name = pausedAll
                ? _('Resume all') : _('Pause all');
        }

        if (this._daemonError) {
            this._jobsSection.removeAll();
            this._rows.clear();
            this._jobsKey = null;
            const item = new PopupMenu.PopupBaseMenuItem({
                reactive: false, activate: false, hover: false,
            });
            const box = new St.BoxLayout({vertical: true, style_class: 'saveme-empty'});
            box.add_child(new St.Label({text: _('SaveMe daemon is not available')}));
            const detail = new St.Label({
                text: this._daemonError,
                style_class: 'saveme-job-detail',
            });
            box.add_child(detail);
            item.add_child(box);
            this._jobsSection.addMenuItem(item);
            return;
        }

        const jobs = this._snapshot?.jobs || [];
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
                box.add_child(new St.Label({text: _('No jobs configured')}));
                item.add_child(box);
                this._jobsSection.addMenuItem(item);
            }
        } else {
            for (const job of jobs)
                this._rows.get(job.id)?.update(job);
        }
    }

    runJob(jobId) {
        this._call('RunJob', new GLib.Variant('(sbb)', [jobId, false, false]));
    }

    cancelJob(jobId) {
        this._call('CancelJob', new GLib.Variant('(s)', [jobId]));
    }

    pauseJob(jobId, paused) {
        this._call('PauseJob', new GLib.Variant('(sb)', [jobId, paused]));
    }

    _togglePauseAll() {
        const paused = !this._snapshot?.pausedAll;
        this._call('PauseAll', new GLib.Variant('(b)', [paused]));
    }

    _openApp(args) {
        try {
            const program = GLib.find_program_in_path('saveme-settings');
            if (!program) {
                Main.notify('SaveMe', _('SaveMe Settings is not installed'));
                return;
            }
            Gio.Subprocess.new([program, ...args], Gio.SubprocessFlags.NONE);
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
