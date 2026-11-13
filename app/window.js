import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {JobEditor} from './job-editor.js';
import {AccountDialog} from './account-dialog.js';
import {RestoreDialog} from './restore-dialog.js';
import {LogDialog} from './log-dialog.js';
import {VolumeResolver} from '../src/volumes.js';
import {descriptorDisplay, JOB_TYPES} from '../src/jobs.js';
import {sleep} from '../src/util.js';

const APP_DIR = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const ROOT_DIR = GLib.build_filenamev([APP_DIR, '..']);

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

const RESULT_LABELS = {
    'success': 'Success',
    'noop': 'No changes',
    'error': 'Error',
    'cancelled': 'Cancelled',
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
        return 'just now';
    if (diff < 3_600_000)
        return `${Math.floor(diff / 60_000)} min ago`;
    if (diff < 86_400_000)
        return `${Math.floor(diff / 3_600_000)} h ago`;
    return `${Math.floor(diff / 86_400_000)} d ago`;
}

function readTail(path, maxLines = 800) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok)
            return '';
        const lines = new TextDecoder().decode(bytes).split('\n');
        return lines.slice(Math.max(0, lines.length - maxLines)).join('\n');
    } catch (_) {
        return '';
    }
}

function openPath(path) {
    try {
        Gio.Subprocess.new(['xdg-open', path], Gio.SubprocessFlags.NONE);
    } catch (_) {
        // The caller can report a toast if needed.
    }
}

function statusLabel(status) {
    return STATUS_LABELS[status] || status || 'Idle';
}

function setStatusDot(label, status) {
    for (const cssClass of [...label.get_css_classes()]) {
        if (cssClass.startsWith('saveme-status-'))
            label.remove_css_class(cssClass);
    }
    label.add_css_class('saveme-status-dot');
    label.add_css_class(`saveme-status-${status}`);
}

function typeLabel(type) {
    return type === 'backup' ? 'Backup' : 'Sync';
}

function remoteTypeLabel(type) {
    return {
        drive: 'Google Drive',
        onedrive: 'Microsoft OneDrive',
        dropbox: 'Dropbox',
    }[type] || type;
}

function jobSubtitle(job, volumes) {
    const state = job.state || {};
    let text = `${typeLabel(job.type)} · ${statusLabel(state.status)}`;
    if (state.lastRunAt)
        text += ` · last run ${formatWhen(state.lastRunAt)}`;
    text += ` · ${descriptorDisplay(job.source, volumes)} → ${descriptorDisplay(job.destination, volumes)}`;
    return text;
}

class JobsPage {
    constructor(window) {
        this.window = window;
        this.widget = new Adw.PreferencesPage();
        this.group = null;
        this.rows = new Map();
        this.jobs = [];
        this.structureKey = null;
    }

    update(snapshot) {
        const jobs = snapshot.jobs || [];
        this.jobs = jobs;
        const key = jobs.map(job =>
            `${job.id}:${job.name}:${job.type}:${job.enabled}`).join('|');
        if (key !== this.structureKey) {
            this.structureKey = key;
            this._rebuild(jobs);
        } else {
            for (const job of jobs)
                this._updateRow(job);
        }
    }

    _rebuild(jobs) {
        if (this.group)
            this.widget.remove(this.group);
        this.rows.clear();
        this.group = new Adw.PreferencesGroup({title: 'Jobs'});
        if (jobs.length === 0) {
            const row = new Adw.ActionRow({
                title: 'No jobs configured',
                subtitle: 'Create a job to start syncing.',
            });
            const button = new Gtk.Button({
                label: 'New job',
                valign: Gtk.Align.CENTER,
                css_classes: ['suggested-action'],
            });
            button.connect('clicked', () => this.window.newJob());
            row.add_suffix(button);
            this.group.add(row);
        } else {
            for (const job of jobs) {
                const entry = this._makeRow(job);
                this.rows.set(job.id, entry);
                this.group.add(entry.row);
            }
        }
        this.widget.add(this.group);
    }

    _makeRow(job) {
        const row = new Adw.ActionRow({
            title: job.name || job.id,
            subtitle: jobSubtitle(job, this.window.volumes),
        });
        const dot = new Gtk.Label({label: '●', valign: Gtk.Align.CENTER});
        setStatusDot(dot, job.state?.status || 'idle');
        row.add_prefix(dot);

        const toggle = new Gtk.Switch({
            active: Boolean(job.enabled),
            valign: Gtk.Align.CENTER,
        });
        toggle.connect('notify::active', () => {
            if (toggle._saveMeUpdating)
                return;
            this.window.client.setJobEnabled(job.id, toggle.active)
                .catch(e => this.window.toast(e.message));
        });
        row.add_suffix(toggle);

        const menu = new Gtk.MenuButton({
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        menu.set_child(new Gtk.Image({icon_name: 'view-more-symbolic'}));
        menu.set_popover(this._makeMenu(job));
        row.add_suffix(menu);

        if (job.state?.message)
            row.set_tooltip_text(job.state.message);
        return {row, dot, toggle, menu, job};
    }

    _makeMenu(job) {
        const popover = new Gtk.Popover();
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: 6,
        });
        const add = (label, callback, destructive = false) => {
            const button = new Gtk.Button({
                label,
                css_classes: destructive ? ['flat', 'destructive-action'] : ['flat'],
            });
            button.connect('clicked', () => {
                popover.popdown();
                callback();
            });
            box.append(button);
        };
        const running = job.state?.status === 'running';
        add('Run now', () => {
            this.window.client.runJob(job.id)
                .then(() => this.window.toast('Run started.'))
                .catch(e => this.window.toast(e.message));
        });
        add('Dry run', () => {
            this.window.client.runJob(job.id, true)
                .then(() => this.window.toast('Dry run started. Check Logs.'))
                .catch(e => this.window.toast(e.message));
        });
        if (job.state?.status === 'delete-guard') {
            add('Force run', () => {
                this.window.confirm('Force run?',
                    'This run would delete more files than the configured limit. ' +
                    'Review the dry-run log before continuing.',
                    true, () => {
                        this.window.client.runJob(job.id, false, true)
                            .then(() => this.window.toast('Forced run started.'))
                            .catch(e => this.window.toast(e.message));
                    });
            }, true);
        }
        if (running) {
            add('Cancel', () => {
                this.window.client.cancelJob(job.id)
                    .catch(e => this.window.toast(e.message));
            });
        }
        add(job.state?.paused ? 'Resume' : 'Pause', () => {
            this.window.client.pauseJob(job.id, !job.state?.paused)
                .catch(e => this.window.toast(e.message));
        });
        add('Edit', () => this.window.editJob(job));
        add('Logs', () => this.window.openLogs(job.id));
        if (job.type === JOB_TYPES.BACKUP)
            add('Versions and restore', () => this.window.openVersions(job));
        add('Delete', () => {
            this.window.confirm('Delete job?',
                `Delete “${job.name}”? The destination files are not removed.`,
                true, () => {
                    this.window.client.deleteJob(job.id)
                        .then(() => this.window.toast('Job deleted.'))
                        .catch(e => this.window.toast(e.message));
                });
        }, true);
        popover.set_child(box);
        return popover;
    }

    _updateRow(job) {
        const entry = this.rows.get(job.id);
        if (!entry)
            return;
        entry.job = job;
        entry.row.set_title(job.name || job.id);
        entry.row.set_subtitle(jobSubtitle(job, this.window.volumes));
        setStatusDot(entry.dot, job.state?.status || 'idle');
        if (entry.toggle.active !== Boolean(job.enabled)) {
            entry.toggle._saveMeUpdating = true;
            entry.toggle.active = Boolean(job.enabled);
            entry.toggle._saveMeUpdating = false;
        }
        entry.menu.set_popover(this._makeMenu(job));
        entry.row.set_tooltip_text(job.state?.message || '');
    }
}

class AccountsPage {
    constructor(window) {
        this.window = window;
        this.widget = new Adw.PreferencesPage();
        this.group = null;
        this.key = null;
    }

    update(snapshot) {
        const remotes = snapshot.remotes || [];
        const key = remotes.map(remote =>
            `${remote.name}:${remote.type}:${remote.label}:${remote.options?.drive_type || ''}`)
            .join('|');
        if (key === this.key)
            return;
        this.key = key;
        this._rebuild(remotes);
    }

    _rebuild(remotes) {
        if (this.group)
            this.widget.remove(this.group);
        this.group = new Adw.PreferencesGroup({
            title: 'Accounts',
            description: 'Cloud accounts used by sync and backup jobs.',
        });
        if (remotes.length === 0) {
            const row = new Adw.ActionRow({
                title: 'No accounts configured',
                subtitle: 'Add Google Drive, OneDrive or Dropbox.',
            });
            const button = new Gtk.Button({
                label: 'Add account',
                valign: Gtk.Align.CENTER,
                css_classes: ['suggested-action'],
            });
            button.connect('clicked', () => this.window.addAccount(null));
            row.add_suffix(button);
            this.group.add(row);
        } else {
            for (const remote of remotes) {
                const row = new Adw.ActionRow({
                    title: remote.label || remote.name,
                    subtitle: `${remoteTypeLabel(remote.type)} · ${remote.name}`,
                });
                const menu = new Gtk.MenuButton({
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                menu.set_child(new Gtk.Image({icon_name: 'view-more-symbolic'}));
                const popover = new Gtk.Popover();
                const box = new Gtk.Box({
                    orientation: Gtk.Orientation.VERTICAL,
                    spacing: 2,
                    margin_top: 6,
                    margin_bottom: 6,
                    margin_start: 6,
                    margin_end: 6,
                });
                const reauth = new Gtk.Button({label: 'Reauthenticate', css_classes: ['flat']});
                reauth.connect('clicked', () => {
                    popover.popdown();
                    this.window.addAccount(remote);
                });
                const remove = new Gtk.Button({
                    label: 'Delete',
                    css_classes: ['flat', 'destructive-action'],
                });
                remove.connect('clicked', () => {
                    popover.popdown();
                    this.window.confirm('Delete account?',
                        `Delete ${remote.name}? Jobs using it must be removed or edited first.`,
                        true, () => {
                            this.window.client.deleteRemote(remote.name)
                                .then(() => this.window.toast('Account deleted.'))
                                .catch(e => this.window.toast(e.message));
                        });
                });
                box.append(reauth);
                box.append(remove);
                popover.set_child(box);
                menu.set_popover(popover);
                row.add_suffix(menu);
                this.group.add(row);
            }
            const addRow = new Adw.ActionRow({
                title: 'Add account',
                subtitle: 'Connect another cloud account.',
            });
            const addButton = new Gtk.Button({
                label: 'Add',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            addButton.connect('clicked', () => this.window.addAccount(null));
            addRow.add_suffix(addButton);
            this.group.add(addRow);
        }
        this.widget.add(this.group);
    }
}

class LogsPage {
    constructor(window) {
        this.window = window;
        this.widget = new Adw.PreferencesPage();
        this.jobs = [];
        this.jobIds = [];
        this.pendingJobId = null;
        this.structureKey = null;
        this.loadToken = 0;

        const filterGroup = new Adw.PreferencesGroup({title: 'Job'});
        this.jobRow = new Adw.ComboRow({
            title: 'Job',
            model: Gtk.StringList.new(['No jobs']),
        });
        this.jobRow.connect('notify::selected', () => this._loadRuns());
        filterGroup.add(this.jobRow);
        this.widget.add(filterGroup);

        this.runsGroup = new Adw.PreferencesGroup({title: 'Runs'});
        this.widget.add(this.runsGroup);
    }

    update(snapshot) {
        const jobs = snapshot.jobs || [];
        const key = jobs.map(job =>
            `${job.id}:${job.name}:${job.state?.lastRunId || ''}:${job.state?.lastRunAt || ''}`)
            .join('|');
        this.jobs = jobs;
        this.jobIds = jobs.map(job => job.id);
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
                ].filter(Boolean);
                if (run.message)
                    parts.push(run.message);
                const row = new Adw.ActionRow({
                    title: `${RESULT_LABELS[run.result] || run.result} · ${formatWhen(run.startedAt)}`,
                    subtitle: parts.join(' · '),
                });
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
            this._loadRuns();
        }
    }
}

class SettingsPage {
    constructor(window) {
        this.window = window;
        this.widget = new Adw.PreferencesPage();
        this.blockPauseUpdate = false;
        const daemonGroup = new Adw.PreferencesGroup({title: 'Daemon'});
        this.statusRow = new Adw.ActionRow({title: 'Status', subtitle: 'Unknown'});
        this.rcloneRow = new Adw.ActionRow({title: 'rclone', subtitle: 'Unknown'});
        this.pauseAllRow = new Adw.SwitchRow({title: 'Pause all jobs'});
        this.pauseAllRow.connect('notify::active', () => {
            if (this.blockPauseUpdate)
                return;
            this.window.client.pauseAll(this.pauseAllRow.active)
                .catch(e => this.window.toast(e.message));
        });
        this.doctorRow = new Adw.ActionRow({
            title: 'Diagnostics',
            subtitle: 'Check rclone, configuration and volumes.',
        });
        const doctorButton = new Gtk.Button({
            label: 'Run doctor',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        doctorButton.connect('clicked', () => this._runDoctor());
        this.doctorRow.add_suffix(doctorButton);
        this.logsRow = new Adw.ActionRow({
            title: 'Log files',
            subtitle: 'Open the log folder.',
        });
        const logsButton = new Gtk.Button({
            label: 'Open folder',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        logsButton.connect('clicked', () => this._openLogsFolder());
        this.logsRow.add_suffix(logsButton);
        daemonGroup.add(this.statusRow);
        daemonGroup.add(this.rcloneRow);
        daemonGroup.add(this.pauseAllRow);
        daemonGroup.add(this.doctorRow);
        daemonGroup.add(this.logsRow);
        this.widget.add(daemonGroup);

        const aboutGroup = new Adw.PreferencesGroup({title: 'About'});
        this.versionRow = new Adw.ActionRow({title: 'Version'});
        aboutGroup.add(this.versionRow);
        this.widget.add(aboutGroup);
    }

    update(snapshot) {
        const daemon = snapshot.daemon || {};
        this.statusRow.set_subtitle(
            `Running · PID ${daemon.pid ?? '?'} · started ${formatWhen(daemon.startedAt)}`);
        this.rcloneRow.set_subtitle(
            `${daemon.rclone?.version || 'unknown'} · ${daemon.rclone?.path || '-'}`);
        this.blockPauseUpdate = true;
        this.pauseAllRow.active = Boolean(snapshot.pausedAll);
        this.blockPauseUpdate = false;
        this.versionRow.set_subtitle(snapshot.version || '-');
    }

    async _runDoctor() {
        try {
            const data = await this.window.client.doctor();
            new LogDialog(this.window, 'Doctor', JSON.stringify(data, null, 2)).present();
        } catch (e) {
            this.window.toast(e.message);
        }
    }

    _openLogsFolder() {
        const path = GLib.build_filenamev([GLib.get_user_state_dir(), 'saveme', 'logs']);
        try {
            Gio.Subprocess.new(['xdg-open', path], Gio.SubprocessFlags.NONE);
        } catch (e) {
            this.window.toast(e.message);
        }
    }
}

class DebugPage {
    constructor(window) {
        this.window = window;
        this.widget = new Adw.PreferencesPage();
        this.snapshot = null;
        this.configPath = GLib.build_filenamev([GLib.get_user_config_dir(), 'saveme']);
        this.statePath = GLib.build_filenamev([GLib.get_user_state_dir(), 'saveme']);
        this.logPath = GLib.build_filenamev([this.statePath, 'daemon.log']);

        const systemGroup = new Adw.PreferencesGroup({title: 'System'});
        this.daemonRow = new Adw.ActionRow({title: 'Daemon'});
        this.rcloneRow = new Adw.ActionRow({title: 'rclone'});
        this.configRow = new Adw.ActionRow({title: 'Configuration', subtitle: this.configPath});
        const openConfig = new Gtk.Button({
            label: 'Open',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        openConfig.connect('clicked', () => openPath(this.configPath));
        this.configRow.add_suffix(openConfig);
        this.stateRow = new Adw.ActionRow({title: 'State and logs', subtitle: this.statePath});
        const openState = new Gtk.Button({
            label: 'Open',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        openState.connect('clicked', () => openPath(this.statePath));
        this.stateRow.add_suffix(openState);
        this.volumesRow = new Adw.ActionRow({title: 'Volumes'});
        systemGroup.add(this.daemonRow);
        systemGroup.add(this.rcloneRow);
        systemGroup.add(this.configRow);
        systemGroup.add(this.stateRow);
        systemGroup.add(this.volumesRow);
        this.widget.add(systemGroup);

        const logGroup = new Adw.PreferencesGroup({title: 'Daemon log'});
        this.logView = new Gtk.TextView({
            editable: false,
            monospace: true,
            wrap_mode: Gtk.WrapMode.NONE,
            left_margin: 8,
            right_margin: 8,
            top_margin: 8,
            bottom_margin: 8,
        });
        this.logView.add_css_class('saveme-log-view');
        const scrolled = new Gtk.ScrolledWindow({vexpand: true});
        scrolled.set_size_request(-1, 320);
        scrolled.set_child(this.logView);
        logGroup.add(scrolled);

        const refreshRow = new Adw.ActionRow({
            title: 'Reload log',
            subtitle: 'Show the last 800 lines of daemon.log',
        });
        const refreshButton = new Gtk.Button({
            label: 'Refresh',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        refreshButton.connect('clicked', () => this.refreshLog(true));
        refreshRow.add_suffix(refreshButton);
        logGroup.add(refreshRow);
        this.widget.add(logGroup);

        const actions = new Adw.PreferencesGroup({title: 'Diagnostics'});
        const doctorRow = new Adw.ActionRow({
            title: 'Doctor',
            subtitle: 'Check rclone, paths, volumes and configuration.',
        });
        const doctorButton = new Gtk.Button({
            label: 'Run',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        doctorButton.connect('clicked', () => this._runDoctor());
        doctorRow.add_suffix(doctorButton);
        actions.add(doctorRow);

        const copyRow = new Adw.ActionRow({
            title: 'Copy diagnostics',
            subtitle: 'Snapshot, doctor output and recent daemon log.',
        });
        const copyButton = new Gtk.Button({
            label: 'Copy',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        copyButton.connect('clicked', () => this._copyDiagnostics());
        copyRow.add_suffix(copyButton);
        actions.add(copyRow);
        this.widget.add(actions);
    }

    update(snapshot) {
        this.snapshot = snapshot;
        const daemon = snapshot.daemon || {};
        this.daemonRow.set_subtitle(
            `Running · PID ${daemon.pid ?? '?'} · started ${formatWhen(daemon.startedAt)}`);
        this.rcloneRow.set_subtitle(
            `${daemon.rclone?.version || 'unknown'} · ${daemon.rclone?.path || '-'}`);
        this.volumesRow.set_subtitle(
            `${(snapshot.volumes || []).length} mounted volume(s)`);
    }

    onShown() {
        this.refreshLog(false);
    }

    refreshLog(showToast = false) {
        const text = readTail(this.logPath, 800);
        this.logView.get_buffer().set_text(text || '(empty)', -1);
        if (showToast)
            this.window.toast('Daemon log refreshed.');
    }

    async _runDoctor() {
        try {
            const data = await this.window.client.doctor();
            new LogDialog(this.window, 'Doctor', JSON.stringify(data, null, 2)).present();
        } catch (e) {
            this.window.toast(e.message);
        }
    }

    async _copyDiagnostics() {
        const parts = [
            `SaveMe ${this.snapshot?.version || '?'}`,
            `Snapshot:\n${JSON.stringify(this.snapshot || {}, null, 2)}`,
        ];
        try {
            parts.push(`Doctor:\n${JSON.stringify(await this.window.client.doctor(), null, 2)}`);
        } catch (e) {
            parts.push(`Doctor error: ${e.message}`);
        }
        parts.push(`Daemon log:\n${readTail(this.logPath, 400) || '(empty)'}`);
        try {
            this.widget.get_clipboard().set(parts.join('\n\n'));
            this.window.toast('Diagnostics copied.');
        } catch (e) {
            this.window.toast(`Cannot copy diagnostics: ${e.message}`);
        }
    }
}

export const SaveMeWindow = GObject.registerClass({
    GTypeName: 'SaveMeSettingsWindow',
}, class SaveMeWindow extends Adw.ApplicationWindow {
    constructor(app, client) {
        super({
            application: app,
            title: 'SaveMe',
            default_width: 980,
            default_height: 720,
        });
        this.app = app;
        this.client = client;
        this.volumes = new VolumeResolver();
        this.snapshot = null;
        this._daemonStatus = null;
        this._unsubscribe = null;
        this._buildUI();

        this._unsubscribe = this.client.onSnapshot(json => {
            try {
                this._applySnapshot(JSON.parse(json));
            } catch (e) {
                this.toast(`Invalid snapshot: ${e.message}`);
            }
        });
        this.connect('close-request', () => {
            this._unsubscribe?.();
            this._unsubscribe = null;
            return false;
        });
        this.refresh();
    }

    _buildUI() {
        const header = new Adw.HeaderBar();
        this.stack = new Adw.ViewStack();
        this.viewSwitcher = new Adw.ViewSwitcherTitle({stack: this.stack});
        header.set_title_widget(this.viewSwitcher);

        const newJob = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: 'New job',
            css_classes: ['flat'],
        });
        newJob.connect('clicked', () => this.newJob());
        header.pack_end(newJob);
        const refresh = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: 'Refresh',
            css_classes: ['flat'],
        });
        refresh.connect('clicked', () => this.refresh());
        header.pack_end(refresh);

        this.jobsPage = new JobsPage(this);
        this.accountsPage = new AccountsPage(this);
        this.logsPage = new LogsPage(this);
        this.settingsPage = new SettingsPage(this);
        this.debugPage = new DebugPage(this);
        const jobsPage = this.stack.add_titled(this.jobsPage.widget, 'jobs', 'Jobs');
        jobsPage.set_icon_name('view-list-symbolic');
        const accountsPage = this.stack.add_titled(this.accountsPage.widget, 'accounts', 'Accounts');
        accountsPage.set_icon_name('system-users-symbolic');
        const logsPage = this.stack.add_titled(this.logsPage.widget, 'logs', 'Logs');
        logsPage.set_icon_name('text-x-generic-symbolic');
        const settingsPage = this.stack.add_titled(this.settingsPage.widget, 'settings', 'Settings');
        settingsPage.set_icon_name('emblem-system-symbolic');
        const debugPage = this.stack.add_titled(this.debugPage.widget, 'debug', 'Debug');
        debugPage.set_icon_name('utilities-terminal-symbolic');

        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(header);
        toolbar.set_content(this.stack);
        this.toastOverlay = new Adw.ToastOverlay();
        this.toastOverlay.set_child(toolbar);
        this.set_content(this.toastOverlay);
    }

    async refresh() {
        let lastError = null;
        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                const snapshot = await this.client.getSnapshot();
                this._applySnapshot(snapshot);
                return;
            } catch (e) {
                lastError = e;
                await sleep(250);
            }
        }
        if (this.snapshot)
            return;
        this._showDaemonError(lastError || new Error('Daemon unavailable'));
    }

    _applySnapshot(snapshot) {
        this.snapshot = snapshot;
        if (this.get_content() === this._daemonStatus)
            this.set_content(this.toastOverlay);
        this.jobsPage.update(snapshot);
        this.accountsPage.update(snapshot);
        this.logsPage.update(snapshot);
        this.settingsPage.update(snapshot);
        this.debugPage.update(snapshot);
    }

    _showDaemonError(error) {
        if (!this._daemonStatus) {
            const page = new Adw.StatusPage({
                title: 'SaveMe daemon is not running',
                icon_name: 'dialog-warning-symbolic',
            });
            const box = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 8,
                halign: Gtk.Align.CENTER,
            });
            const start = new Gtk.Button({
                label: 'Start daemon',
                css_classes: ['suggested-action'],
            });
            start.connect('clicked', () => this._startDaemon());
            const retry = new Gtk.Button({label: 'Retry'});
            retry.connect('clicked', () => this.refresh());
            box.append(start);
            box.append(retry);
            page.set_child(box);
            this._daemonStatus = page;
        }
        this._daemonStatus.set_description(error.message);
        this.set_content(this._daemonStatus);
    }

    async _startDaemon() {
        // The D-Bus service may already be activating the daemon. Give it a
        // chance before spawning a second process.
        try {
            const snapshot = await this.client.getSnapshot();
            this._applySnapshot(snapshot);
            return;
        } catch (_) {
            // Continue and spawn it.
        }
        try {
            const program = GLib.find_program_in_path('saveme-daemon');
            let argv = null;
            if (program) {
                argv = [program];
            } else {
                const script = GLib.build_filenamev([ROOT_DIR, 'bin', 'saveme-daemon.js']);
                if (GLib.file_test(script, GLib.FileTest.EXISTS))
                    argv = ['gjs', '-m', script];
            }
            if (!argv) {
                this.toast('saveme-daemon is not installed.');
                return;
            }
            Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_SILENCE |
                Gio.SubprocessFlags.STDERR_SILENCE);
            await sleep(800);
            this.refresh();
        } catch (e) {
            this.toast(e.message);
        }
    }

    toast(message) {
        this.toastOverlay.add_toast(new Adw.Toast({title: message}));
    }

    showView(name, jobId = null) {
        if (['jobs', 'accounts', 'logs', 'settings', 'debug'].includes(name))
            this.stack.set_visible_child_name(name);
        if (name === 'logs' && jobId)
            this.logsPage.selectJob(jobId);
        if (name === 'debug')
            this.debugPage.onShown();
    }

    newJob() {
        new JobEditor(this, null).present();
    }

    editJob(job) {
        new JobEditor(this, job).present();
    }

    addAccount(existing = null) {
        new AccountDialog(this, existing).present();
    }

    openLogs(jobId = null) {
        this.showView('logs', jobId);
    }

    openVersions(job) {
        new RestoreDialog(this, job).present();
    }

    confirm(title, body, destructive, callback) {
        const dialog = new Adw.AlertDialog({heading: title, body});
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('ok', destructive ? 'Delete' : 'Continue');
        dialog.set_response_appearance('ok', destructive
            ? Adw.ResponseAppearance.DESTRUCTIVE
            : Adw.ResponseAppearance.SUGGESTED);
        dialog.connect('response', (_dialog, response) => {
            if (response === 'ok')
                callback();
        });
        dialog.present(this);
    }
});
