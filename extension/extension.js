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
        this.dot = new St.Label({text: '●', style_class: 'saveme-dot saveme-status-idle'});
        this.name = new St.Label({text: job.name, style_class: 'saveme-job-name', x_expand: true});
        this.status = new St.Label({text: '', style_class: 'saveme-job-status'});
        this.top.add_child(this.dot);
        this.top.add_child(this.name);
        this.top.add_child(this.status);
        this.box.add_child(this.top);

        this.detail = new St.Label({text: '', style_class: 'saveme-job-detail'});
        this.box.add_child(this.detail);

        this.progress = new St.Label({text: '', style_class: 'saveme-job-detail'});
        this.box.add_child(this.progress);

        this.actions = new St.BoxLayout({vertical: false, style_class: 'saveme-actions'});
        this.runButton = this._button('media-playback-start-symbolic', _('Run now'), () => {
            extension.runJob(job.id);
        });
        this.pauseButton = this._button('media-playback-pause-symbolic', _('Pause'), () => {
            extension.pauseJob(job.id, !this.job.state?.paused);
        });
        this.cancelButton = this._button('process-stop-symbolic', _('Cancel'), () => {
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

    update(job) {
        this.job = job;
        const state = job.state || {};
        const status = state.status || 'idle';
        this.name.text = job.name || job.id;
        this.status.text = STATUS_LABELS[status] || status;
        this.dot.style_class = `saveme-dot saveme-status-${status}`;

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
            if (p.currentFile)
                text += ` · ${p.currentFile}`;
            this.progress.text = text;
            this.progress.visible = true;
        } else if (state.message) {
            this.progress.text = state.message;
            this.progress.visible = true;
        } else {
            this.progress.text = '';
            this.progress.visible = false;
        }

        const running = status === 'running';
        const paused = Boolean(state.paused);
        this.runButton.visible = !running && job.enabled;
        this.pauseButton.visible = job.enabled;
        this.pauseButton.child.icon_name = paused
            ? 'media-playback-start-symbolic'
            : 'media-playback-pause-symbolic';
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
        const icon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${this.path}/icons/saveme-symbolic.svg`),
            style_class: 'system-status-icon',
        });
        this._indicator.add_child(icon);
        this._indicator.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._refresh();
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
        this._pauseAllButton.child.icon_name = pausedAll
            ? 'media-playback-start-symbolic'
            : 'media-playback-pause-symbolic';
        this._pauseAllButton.accessible_name = pausedAll ? _('Resume all') : _('Pause all');

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
