import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {JobEditor} from './job-editor.js';
import {AccountDialog} from './account-dialog.js';
import {RestoreDialog} from './restore-dialog.js';
import {LogDialog} from './log-dialog.js';
import {RemoteBrowserDialog} from './remote-browser.js';
import {VolumeResolver} from '../src/volumes.js';
import {descriptorDisplay, JOB_TYPES, localPathFor} from '../src/jobs.js';
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

function basenameOf(path) {
    return GLib.path_get_basename(String(path || ''));
}

function truncate(text, max = 60) {
    const value = String(text || '');
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function backupRootDisplay(job) {
    if (job.destination.kind === 'remote') {
        const path = job.destination.path
            ? `${job.destination.path.replace(/\/+$/, '')}/SaveMe/${job.id}`
            : `SaveMe/${job.id}`;
        return `${job.destination.remote}:${path}`;
    }
    return `${String(job.destination.path || '').replace(/\/+$/, '')}/SaveMe/${job.id}`;
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

function resultClass(result) {
    if (result === 'error')
        return 'saveme-status-error';
    if (result === 'cancelled')
        return 'saveme-status-paused';
    return 'saveme-status-idle';
}

function runDuration(run) {
    const start = Date.parse(run.startedAt || '');
    const end = Date.parse(run.finishedAt || '');
    if (!Number.isFinite(start) || !Number.isFinite(end))
        return '';
    const seconds = Math.max(0, Math.round((end - start) / 1000));
    if (seconds < 60)
        return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes}m ${seconds % 60}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
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

function statusIconName(status) {
    if (['error', 'needs-auth', 'delete-guard'].includes(status))
        return 'dialog-error-symbolic';
    if (status === 'running')
        return 'emblem-synchronizing-symbolic';
    if (status === 'paused' || status === 'disabled')
        return 'media-playback-pause-symbolic';
    if (['waiting-source', 'waiting-destination', 'offline'].includes(status))
        return 'dialog-warning-symbolic';
    return 'emblem-ok-symbolic';
}

function setStatusIcon(icon, status) {
    icon.icon_name = statusIconName(status);
    for (const cssClass of [...icon.get_css_classes()]) {
        if (cssClass.startsWith('saveme-status-'))
            icon.remove_css_class(cssClass);
    }
    icon.add_css_class(`saveme-status-${status}`);
}

function makeStatusIcon(status) {
    const icon = new Gtk.Image({
        icon_name: statusIconName(status),
        pixel_size: 16,
        valign: Gtk.Align.CENTER,
    });
    icon.add_css_class(`saveme-status-${status}`);
    return icon;
}

function iconLabelButton(label, iconName, {cssClasses = [], tooltip = null} = {}) {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
    });
    const icon = new Gtk.Image({icon_name: iconName, pixel_size: 16});
    const text = new Gtk.Label({label});
    box.append(icon);
    box.append(text);
    const button = new Gtk.Button({child: box, css_classes: cssClasses});
    if (tooltip)
        button.set_tooltip_text(tooltip);
    button._saveMeIcon = icon;
    button._saveMeLabel = text;
    return button;
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

class JobsPage {
    constructor(window) {
        this.window = window;
        this.jobs = [];
        this.selectedId = null;
        this.rows = new Map();
        this.structureKey = null;
        this.detailsJobId = null;
        this.detail = null;
        this._updatingSelection = false;

        this.widget = new Gtk.Paned({
            orientation: Gtk.Orientation.HORIZONTAL,
            position: 340,
            shrink_start_child: false,
            shrink_end_child: false,
            resize_start_child: false,
            resize_end_child: true,
        });
        this._buildSidebar();
        this._renderDetails();
    }

    _buildSidebar() {
        const sidebar = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        const header = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 12,
            margin_end: 12,
        });
        header.append(new Gtk.Label({
            label: 'Jobs',
            xalign: 0,
            hexpand: true,
            css_classes: ['heading'],
        }));
        const add = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: 'New job',
            css_classes: ['flat'],
        });
        add.connect('clicked', () => this.window.newJob());
        header.append(add);
        sidebar.append(header);

        this.listBox = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.SINGLE,
            activate_on_single_click: true,
            show_separators: true,
        });
        this.listBox.connect('row-selected', (_box, row) => {
            if (this._updatingSelection || !row?._jobId)
                return;
            this.selectedId = row._jobId;
            this._renderDetails();
        });
        const scrolled = new Gtk.ScrolledWindow({vexpand: true, hexpand: true});
        scrolled.set_child(this.listBox);
        sidebar.append(scrolled);
        this.widget.set_start_child(sidebar);
        this.sidebar = sidebar;
    }

    update(snapshot) {
        const jobs = snapshot.jobs || [];
        this.jobs = jobs;
        if (!jobs.some(job => job.id === this.selectedId))
            this.selectedId = jobs[0]?.id || null;

        const key = jobs.map(job =>
            `${job.id}:${job.name}:${job.type}:${job.enabled}`).join('|');
        const structureChanged = key !== this.structureKey;
        if (structureChanged) {
            this.structureKey = key;
            this._rebuildSidebar();
        } else {
            for (const job of jobs)
                this._updateSidebarRow(job);
        }

        const job = jobs.find(item => item.id === this.selectedId) || null;
        if (structureChanged || this.detailsJobId !== this.selectedId || !this.detail)
            this._renderDetails();
        else if (job)
            this._updateDetails(job);
    }

    _clearListBox() {
        let child = this.listBox.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this.listBox.remove(child);
            child = next;
        }
    }

    _rebuildSidebar() {
        this._updatingSelection = true;
        this._clearListBox();
        this.rows.clear();
        for (const job of this.jobs) {
            const entry = this._makeSidebarRow(job);
            this.rows.set(job.id, entry);
            this.listBox.append(entry.row);
        }
        if (this.jobs.length === 0) {
            const row = new Gtk.ListBoxRow({activatable: false, selectable: false});
            row.set_child(new Gtk.Label({
                label: 'No jobs configured',
                xalign: 0,
                margin_top: 12,
                margin_bottom: 12,
                margin_start: 12,
                margin_end: 12,
                css_classes: ['dim-label'],
            }));
            this.listBox.append(row);
        }
        const selected = this.rows.get(this.selectedId) ||
            this.rows.values().next().value || null;
        if (selected) {
            this.selectedId = selected.row._jobId;
            this.listBox.select_row(selected.row);
        } else {
            this.selectedId = null;
        }
        this._updatingSelection = false;
    }

    _makeSidebarRow(job) {
        const row = new Gtk.ListBoxRow();
        row._jobId = job.id;
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 10,
            margin_end: 10,
        });
        const top = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 8});
        const dot = makeStatusIcon(job.state?.status || 'idle');
        const name = new Gtk.Label({
            label: job.name || job.id,
            xalign: 0,
            hexpand: true,
            ellipsize: Pango.EllipsizeMode.END,
        });
        name.add_css_class('saveme-job-title');
        const status = new Gtk.Label({
            label: statusLabel(job.state?.status),
            css_classes: ['dim-label'],
        });
        top.append(dot);
        top.append(name);
        top.append(status);

        const subtitle = new Gtk.Label({
            label: this._sidebarSubtitle(job),
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.END,
            css_classes: ['dim-label'],
        });
        const paths = new Gtk.Label({
            label: this._sidebarPaths(job),
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.END,
            css_classes: ['saveme-sidebar-paths'],
        });
        paths.set_tooltip_text(this._sidebarPaths(job, false));
        const progress = new Gtk.ProgressBar({
            visible: false,
            height_request: 6,
            margin_top: 2,
        });
        box.append(top);
        box.append(subtitle);
        box.append(paths);
        box.append(progress);
        row.set_child(box);
        const entry = {row, dot, name, status, subtitle, paths, progress, job};
        this._updateSidebarProgress(entry, job);
        return entry;
    }

    _sidebarPaths(job, short = true) {
        const source = descriptorDisplay(job.source, this.window.volumes);
        const destination = job.type === JOB_TYPES.BACKUP
            ? backupRootDisplay(job)
            : descriptorDisplay(job.destination, this.window.volumes);
        const text = `${source} → ${destination}`;
        return short ? truncate(text, 54) : text;
    }

    _sidebarSubtitle(job) {
        const state = job.state || {};
        const progress = state.progress;
        if (state.status === 'running' && progress) {
            return `${typeLabel(job.type)} · ${Math.round(progress.percent || 0)}% · ` +
                `${formatBytes(progress.bytes)} / ${formatBytes(progress.totalBytes)}`;
        }
        let text = `${typeLabel(job.type)} · ${statusLabel(state.status)}`;
        if (state.lastRunAt)
            text += ` · ${formatWhen(state.lastRunAt)}`;
        return text;
    }

    _updateSidebarProgress(entry, job) {
        const progress = job.state?.progress;
        if (job.state?.status === 'running' && progress) {
            entry.progress.visible = true;
            entry.progress.set_fraction(
                Math.max(0, Math.min(1, Number(progress.percent || 0) / 100)));
        } else {
            entry.progress.visible = false;
            entry.progress.set_fraction(0);
        }
    }

    _updateSidebarRow(job) {
        const entry = this.rows.get(job.id);
        if (!entry)
            return;
        entry.job = job;
        entry.name.set_text(job.name || job.id);
        entry.status.set_text(statusLabel(job.state?.status));
        setStatusIcon(entry.dot, job.state?.status || 'idle');
        entry.subtitle.set_text(this._sidebarSubtitle(job));
        entry.paths.set_text(this._sidebarPaths(job));
        entry.paths.set_tooltip_text(this._sidebarPaths(job, false));
        this._updateSidebarProgress(entry, job);
    }

    _renderDetails() {
        const job = this.jobs.find(item => item.id === this.selectedId) || null;
        const scroll = new Gtk.ScrolledWindow({vexpand: true, hexpand: true});
        this.detailsScroll = scroll;
        this.widget.set_end_child(scroll);
        this.detail = null;
        this.detailsJobId = job?.id || null;

        if (!job) {
            const page = new Adw.StatusPage({
                title: 'No jobs configured',
                description: 'Create a job to start syncing.',
                icon_name: 'view-list-symbolic',
            });
            const button = new Gtk.Button({
                label: 'New job',
                halign: Gtk.Align.CENTER,
                css_classes: ['suggested-action'],
            });
            button.connect('clicked', () => this.window.newJob());
            page.set_child(button);
            scroll.set_child(page);
            return;
        }

        const page = new Adw.PreferencesPage();
        const clamp = new Adw.Clamp({
            maximum_size: 760,
            tightening_threshold: 600,
            child: page,
        });
        scroll.set_child(clamp);

        const state = job.state || {};
        const statusGroup = new Adw.PreferencesGroup({title: 'Status'});
        const statusRow = new Adw.ActionRow({
            title: job.name || job.id,
            subtitle: `${typeLabel(job.type)} · ${statusLabel(state.status)}`,
        });
        const dot = makeStatusIcon(state.status || 'idle');
        statusRow.add_prefix(dot);
        const openButton = iconLabelButton('Open destination', 'folder-open-symbolic', {
            cssClasses: ['flat'],
        });
        openButton.connect('clicked', () => this.window.openDestination(job));
        statusRow.add_suffix(openButton);
        statusGroup.add(statusRow);

        const progressBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            margin_top: 6,
            margin_bottom: 6,
        });
        const progress = new Gtk.ProgressBar({show_text: true});
        const current = new Gtk.Label({
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.END,
            css_classes: ['dim-label'],
            visible: false,
        });
        progressBox.append(progress);
        progressBox.append(current);
        statusGroup.add(progressBox);
        page.add(statusGroup);

        const paths = new Adw.PreferencesGroup({title: 'Source and destination'});
        const sourceRow = new Adw.ActionRow({
            title: 'Source',
            subtitle: descriptorDisplay(job.source, this.window.volumes),
        });
        const sourceOpen = iconLabelButton('Open', 'folder-open-symbolic', {
            cssClasses: ['flat'],
        });
        sourceOpen.connect('clicked', () => this.window.openSource(job));
        sourceRow.add_suffix(sourceOpen);
        const destinationRow = new Adw.ActionRow({
            title: 'Destination',
            subtitle: job.type === JOB_TYPES.BACKUP
                ? `${descriptorDisplay(job.destination, this.window.volumes)} (base)`
                : descriptorDisplay(job.destination, this.window.volumes),
        });
        const destinationOpen = iconLabelButton('Open', 'folder-open-symbolic', {
            cssClasses: ['flat'],
        });
        destinationOpen.connect('clicked', () => this.window.openDestination(job));
        destinationRow.add_suffix(destinationOpen);
        paths.add(sourceRow);
        paths.add(destinationRow);
        if (job.type === JOB_TYPES.BACKUP) {
            const backupRow = new Adw.ActionRow({
                title: 'Backup folder',
                subtitle: backupRootDisplay(job),
            });
            const backupOpen = iconLabelButton('Open', 'folder-open-symbolic', {
                cssClasses: ['flat'],
            });
            backupOpen.connect('clicked', () => this.window.openBackupRoot(job));
            backupRow.add_suffix(backupOpen);
            paths.add(backupRow);
        }
        page.add(paths);

        const stats = new Adw.PreferencesGroup({title: 'Statistics'});
        const statsRows = {
            files: this._statRow('Files'),
            data: this._statRow('Data'),
            speed: this._statRow('Speed / ETA'),
            deletes: this._statRow('Deletes / errors'),
            last: this._statRow('Last run'),
            message: this._statRow('Message'),
        };
        for (const row of Object.values(statsRows))
            stats.add(row);
        page.add(stats);

        const actions = new Adw.PreferencesGroup({title: 'Actions'});
        const flow = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE,
            max_children_per_line: 4,
            column_spacing: 6,
            row_spacing: 6,
            margin_top: 6,
            margin_bottom: 6,
        });
        const addAction = (label, iconName, cssClasses, callback) => {
            const button = iconLabelButton(label, iconName, {cssClasses});
            button.connect('clicked', callback);
            flow.append(button);
            return button;
        };
        const runButton = addAction('Run now', 'media-playback-start-symbolic',
            ['suggested-action'], () => {
                this.window.client.runJob(job.id)
                    .then(() => this.window.toast('Run started.'))
                    .catch(e => this.window.toast(e.message));
            });
        addAction('Dry run', 'system-run-symbolic', [], () => {
            this.window.client.runJob(job.id, true)
                .then(() => this.window.toast('Dry run started. Check Logs.'))
                .catch(e => this.window.toast(e.message));
        });
        const pauseButton = addAction(state.paused ? 'Resume' : 'Pause',
            state.paused ? 'media-playback-start-symbolic' : 'media-playback-pause-symbolic',
            [], () => {
                this.window.client.pauseJob(job.id, !this._currentJob()?.state?.paused)
                    .catch(e => this.window.toast(e.message));
            });
        const stopButton = addAction('Stop', 'process-stop-symbolic',
            ['destructive-action'], () => {
                this.window.client.cancelJob(job.id)
                    .catch(e => this.window.toast(e.message));
            });
        addAction('Edit', 'document-edit-symbolic', [], () => this.window.editJob(job));
        addAction('Logs', 'text-x-generic-symbolic', [], () => this.window.openLogs(job.id));
        if (job.type === JOB_TYPES.BACKUP) {
            addAction('Versions / restore', 'document-revert-symbolic', [],
                () => this.window.openVersions(job));
        }
        addAction('Delete', 'edit-delete-symbolic', ['destructive-action'], () => {
            this.window.confirm('Delete job?',
                `Delete “${job.name}”? The destination files are not removed.`,
                true, () => {
                    this.window.client.deleteJob(job.id)
                        .then(() => this.window.toast('Job deleted.'))
                        .catch(e => this.window.toast(e.message));
                });
        });
        actions.add(flow);
        page.add(actions);

        const configuration = new Adw.PreferencesGroup({title: 'Configuration'});
        configuration.add(this._statRow('Schedule',
            job.trigger.mode === 'interval'
                ? `every ${job.trigger.intervalMinutes} minutes`
                : job.trigger.mode));
        configuration.add(this._statRow('Delete guard',
            `${job.options.maxDeletePercent}% (minimum ${job.options.maxDeleteMinimum})`));
        if (job.type === JOB_TYPES.BACKUP) {
            configuration.add(this._statRow('Retention',
                job.backup.retentionDays > 0
                    ? `${job.backup.retentionDays} days`
                    : 'keep versions forever'));
        }
        if (job.filters.exclude?.length) {
            configuration.add(this._statRow('Excludes',
                job.filters.exclude.join(', ')));
        }
        page.add(configuration);

        this.detail = {
            jobId: job.id,
            statusRow,
            dot,
            progress,
            current,
            stats: statsRows,
            runButton,
            pauseButton,
            stopButton,
        };
        this._updateDetails(job);
    }

    _currentJob() {
        return this.jobs.find(item => item.id === this.selectedId) || null;
    }

    _statRow(title, subtitle = '') {
        return new Adw.ActionRow({title, subtitle});
    }

    _updateDetails(job) {
        if (!this.detail || this.detail.jobId !== job.id) {
            this._renderDetails();
            return;
        }
        const state = job.state || {};
        const progress = state.progress;
        this.detail.statusRow.set_subtitle(
            `${typeLabel(job.type)} · ${statusLabel(state.status)}`);
        setStatusIcon(this.detail.dot, state.status || 'idle');

        if (progress) {
            this.detail.progress.set_fraction(
                Math.max(0, Math.min(1, Number(progress.percent || 0) / 100)));
            this.detail.progress.set_text(
                `${Math.round(progress.percent || 0)}% · ` +
                `${formatBytes(progress.bytes)} / ${formatBytes(progress.totalBytes)}`);
            const currentPath = progress.currentPath || progress.currentFile;
            if (currentPath) {
                this.detail.current.set_text(
                    truncate(basenameOf(currentPath), 64));
                this.detail.current.set_tooltip_text(currentPath);
                this.detail.current.visible = true;
            } else {
                this.detail.current.visible = false;
            }
        } else {
            this.detail.progress.set_fraction(0);
            this.detail.progress.set_text(statusLabel(state.status));
            this.detail.current.visible = false;
        }

        this.detail.stats.files.set_subtitle(progress
            ? `${progress.files || 0} / ${progress.totalFiles || 0}`
            : '-');
        this.detail.stats.data.set_subtitle(progress
            ? `${formatBytes(progress.bytes)} / ${formatBytes(progress.totalBytes)}`
            : '-');
        this.detail.stats.speed.set_subtitle(progress
            ? `${formatBytes(progress.speed)}/s · ETA ${formatEta(progress.eta)}`
            : '-');
        this.detail.stats.deletes.set_subtitle(progress
            ? `${progress.deletes || 0} / ${progress.errors || 0}`
            : '-');
        this.detail.stats.last.set_subtitle(state.lastRunAt
            ? `${state.lastResult || '-'} · ${formatWhen(state.lastRunAt)}`
            : 'never');
        this.detail.stats.message.set_subtitle(state.message || '');
        this.detail.stats.message.visible = Boolean(state.message);

        const running = state.status === 'running';
        this.detail.runButton.sensitive = !running;
        this.detail.stopButton.sensitive = running;
        if (this.detail.pauseButton._saveMeLabel)
            this.detail.pauseButton._saveMeLabel.label = state.paused ? 'Resume' : 'Pause';
        if (this.detail.pauseButton._saveMeIcon) {
            this.detail.pauseButton._saveMeIcon.icon_name = state.paused
                ? 'media-playback-start-symbolic'
                : 'media-playback-pause-symbolic';
        }
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
                row.add_prefix(new Gtk.Image({
                    icon_name: 'folder-remote-symbolic',
                    pixel_size: 16,
                }));
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

        this.summaryGroup = new Adw.PreferencesGroup({title: 'Status'});
        this.statusRow = new Adw.ActionRow({title: 'Job', subtitle: 'No job selected'});
        this.destinationRow = new Adw.ActionRow({title: 'Destination'});
        this.openDestination = new Gtk.Button({
            label: 'Open',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        this.openDestination.connect('clicked', () => {
            const job = this._selectedJob();
            if (job)
                this.window.openDestination(job);
        });
        this.destinationRow.add_suffix(this.openDestination);
        this.progress = new Gtk.ProgressBar({show_text: true, visible: false});
        this.currentLabel = new Gtk.Label({
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.END,
            visible: false,
            css_classes: ['dim-label'],
        });
        const progressBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            margin_top: 6,
            margin_bottom: 6,
        });
        progressBox.append(this.progress);
        progressBox.append(this.currentLabel);
        this.activeRow = new Adw.ActionRow({title: 'Active run'});
        this.cancelButton = new Gtk.Button({
            label: 'Stop',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        this.cancelButton.connect('clicked', () => {
            const job = this._selectedJob();
            if (!job)
                return;
            this.window.client.cancelJob(job.id)
                .catch(e => this.window.toast(e.message));
        });
        this.activeRow.add_suffix(this.cancelButton);
        this.summaryGroup.add(this.statusRow);
        this.summaryGroup.add(this.destinationRow);
        this.summaryGroup.add(progressBox);
        this.summaryGroup.add(this.activeRow);
        this.widget.add(this.summaryGroup);

        const filterGroup = new Adw.PreferencesGroup({title: 'Select job'});
        this.jobRow = new Adw.ComboRow({
            title: 'Job',
            model: Gtk.StringList.new(['No jobs']),
        });
        this.jobRow.connect('notify::selected', () => {
            this._loadRuns();
            this._updateSummary();
        });
        filterGroup.add(this.jobRow);
        this.widget.add(filterGroup);

        this.runsGroup = new Adw.PreferencesGroup({title: 'Runs'});
        this.widget.add(this.runsGroup);
        this._updateSummary();
    }

    _selectedJob() {
        const id = this.jobIds[this.jobRow.selected];
        return this.jobs.find(job => job.id === id) || null;
    }

    update(snapshot) {
        const jobs = snapshot.jobs || [];
        const key = jobs.map(job =>
            `${job.id}:${job.name}:${job.state?.lastRunId || ''}:` +
            `${job.state?.lastRunAt || ''}`)
            .join('|');
        this.jobs = jobs;
        this.jobIds = jobs.map(job => job.id);
        this._updateSummary();
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

    _updateSummary() {
        const job = this._selectedJob();
        if (!job) {
            this.statusRow.set_title('Job');
            this.statusRow.set_subtitle('No job selected');
            this.destinationRow.set_subtitle('-');
            this.progress.visible = false;
            this.currentLabel.visible = false;
            this.activeRow.visible = false;
            return;
        }
        const state = job.state || {};
        const progress = state.progress;
        this.statusRow.set_title(job.name || job.id);
        this.statusRow.set_subtitle(
            `${typeLabel(job.type)} · ${statusLabel(state.status)}` +
            (state.lastRunAt ? ` · last run ${formatWhen(state.lastRunAt)}` : ''));
        this.destinationRow.set_subtitle(
            descriptorDisplay(job.destination, this.window.volumes));

        const running = state.status === 'running';
        this.activeRow.visible = running;
        if (progress) {
            this.progress.visible = true;
            this.progress.set_fraction(
                Math.max(0, Math.min(1, Number(progress.percent || 0) / 100)));
            this.progress.set_text(
                `${Math.round(progress.percent || 0)}% · ` +
                `${formatBytes(progress.bytes)} / ${formatBytes(progress.totalBytes)}`);
            const currentPath = progress.currentPath || progress.currentFile;
            if (currentPath) {
                this.currentLabel.set_text(
                    truncate(basenameOf(currentPath), 72));
                this.currentLabel.set_tooltip_text(currentPath);
                this.currentLabel.visible = true;
            } else {
                this.currentLabel.visible = false;
            }
            this.activeRow.set_subtitle(
                `${progress.files || 0} / ${progress.totalFiles || 0} files · ` +
                `${formatBytes(progress.bytes)} / ${formatBytes(progress.totalBytes)} · ` +
                `ETA ${formatEta(progress.eta)}`);
        } else {
            this.progress.visible = false;
            this.currentLabel.visible = false;
            this.activeRow.set_subtitle('Running');
        }
        this.cancelButton.visible = running;
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
                    `${stats.deletes || 0} deletes`,
                    `${stats.errors || 0} errors`,
                    runDuration(run),
                ].filter(Boolean);
                if (run.message)
                    parts.push(run.message);
                const row = new Adw.ActionRow({
                    title: `${RESULT_LABELS[run.result] || run.result} · ${formatWhen(run.startedAt)}`,
                    subtitle: parts.join(' · '),
                });
                const dot = new Gtk.Image({
                    icon_name: run.result === 'error' ? 'dialog-error-symbolic'
                        : run.result === 'cancelled' ? 'media-playback-pause-symbolic'
                            : 'emblem-ok-symbolic',
                    pixel_size: 14,
                });
                dot.add_css_class(resultClass(run.result));
                row.add_prefix(dot);
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
            this._updateSummary();
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

    openSource(job) {
        this._openJobPath(job.source);
    }

    openDestination(job) {
        this._openJobPath(job.destination);
    }

    openBackupRoot(job) {
        if (!job || job.type !== JOB_TYPES.BACKUP)
            return this.openDestination(job);
        if (job.destination.kind === 'remote') {
            const path = job.destination.path
                ? `${job.destination.path.replace(/\/+$/, '')}/SaveMe/${job.id}`
                : `SaveMe/${job.id}`;
            new RemoteBrowserDialog(this, {
                mode: 'browse',
                remote: job.destination.remote,
                path,
            }).present();
            return;
        }
        let base;
        try {
            base = localPathFor(job.destination, this.volumes);
        } catch (e) {
            this.toast(e.message);
            return;
        }
        const path = `${String(base || '').replace(/\/+$/, '')}/SaveMe/${job.id}`;
        if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
            this.toast(`Backup folder not created yet: ${path}`);
            return;
        }
        try {
            Gio.AppInfo.launch_default_for_uri(
                Gio.File.new_for_path(path).get_uri(), null);
        } catch (e) {
            this.toast(e.message);
        }
    }

    _openJobPath(descriptor) {
        if (!descriptor)
            return;
        if (descriptor.kind === 'remote') {
            new RemoteBrowserDialog(this, {
                mode: 'browse',
                remote: descriptor.remote,
                path: descriptor.path || '',
            }).present();
            return;
        }
        let path;
        try {
            path = localPathFor(descriptor, this.volumes);
        } catch (e) {
            this.toast(e.message);
            return;
        }
        if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS)) {
            this.toast(`Path not available: ${path || descriptor.path || ''}`);
            return;
        }
        try {
            Gio.AppInfo.launch_default_for_uri(
                Gio.File.new_for_path(path).get_uri(), null);
        } catch (e) {
            this.toast(e.message);
        }
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
