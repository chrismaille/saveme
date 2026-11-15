import Pango from 'gi://Pango';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import {JOB_TYPES, descriptorDisplay, jobSources, localPathFor} from '../../src/jobs.js';
import {triggerLabel} from '../../src/domain/schedule.js';
import {RecoverDialog} from '../recover-dialog.js';
import {
    backupRootDisplay,
    cleanError,
    displayStatus,
    formatBytes,
    formatDateTime,
    formatEta,
    formatWhen,
    statusLabel,
    remoteTypeLabel,
    RESULT_LABELS,
    truncate,
    typeLabel,
} from '../presentation/format.js';
import {
    basenameOf,
    iconButton,
    iconLabelButton,
    makeStatusVisual,
    setStatusVisual,
} from '../widgets/common.js';

export class JobsPage {
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
        const recover = new Gtk.Button({
            icon_name: 'document-revert-symbolic',
            tooltip_text: 'Recover backup',
            css_classes: ['flat'],
        });
        recover.connect('clicked', () => new RecoverDialog(this.window).present());
        header.append(recover);
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
        const dot = makeStatusVisual(job.draft ? 'draft' : (job.state?.status || 'idle'));
        const name = new Gtk.Label({
            label: job.name || job.id,
            xalign: 0,
            hexpand: true,
            ellipsize: Pango.EllipsizeMode.END,
        });
        name.add_css_class('saveme-job-title');
        const display = job.draft
            ? 'draft'
            : displayStatus(job.state?.status, job.state?.progress?.phase);
        const status = new Gtk.Label({
            label: statusLabel(display),
            css_classes: ['saveme-badge', `saveme-job-status-${display}`],
        });
        top.append(dot);
        top.append(name);
        top.append(status);

        const meta = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 6});
        const typeBadge = new Gtk.Label({
            label: typeLabel(job.type),
            css_classes: ['saveme-badge', `saveme-badge-${job.type}`],
        });
        const sourceCount = jobSources(job).length;
        const sourcesBadge = new Gtk.Label({
            label: `${sourceCount} source${sourceCount === 1 ? '' : 's'}`,
            css_classes: ['saveme-badge', 'saveme-badge-sources'],
        });
        meta.append(typeBadge);
        if (sourceCount > 1)
            meta.append(sourcesBadge);

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
        box.append(meta);
        box.append(subtitle);
        box.append(paths);
        box.append(progress);
        row.set_child(box);
        if (job.draft)
            row.add_css_class('saveme-job-draft');
        const entry = {row, dot, name, status, typeBadge, sourcesBadge, subtitle,
            paths, progress, job};
        this._updateSidebarProgress(entry, job);
        return entry;
    }

    _sidebarPaths(job, short = true) {
        if (job.draft)
            return 'Draft — open to continue';
        const sources = jobSources(job);
        const source = sources.length === 1
            ? descriptorDisplay(sources[0], this.window.volumes)
            : sources.map(item => descriptorDisplay(item, this.window.volumes)).join(' + ');
        const destination = job.type === JOB_TYPES.BACKUP
            ? backupRootDisplay(job)
            : descriptorDisplay(job.destination, this.window.volumes);
        const text = `${source} → ${destination}`;
        return short ? truncate(text, 54) : text;
    }

    _sidebarSubtitle(job) {
        if (job.draft)
            return 'Draft · continue setup';
        const state = job.state || {};
        const progress = state.progress;
        const display = displayStatus(state.status, progress?.phase);
        if (display === 'checking') {            const listed = Number(progress?.listed || 0);
            return listed > 0
                ? `Checking · ${listed.toLocaleString()} files`
                : 'Checking · preparing backup';
        }
        if (display === 'running' && progress) {
            return `${Math.round(progress.percent || 0)}% · ` +
                `${formatBytes(progress.bytes)} / ${formatBytes(progress.totalBytes)}`;
        }
        if (display === 'finalizing')
            return 'Finalizing · cleaning versions';
        if (display === 'queued')
            return 'Queued · waiting for a free slot';
        if (state.lastFinishedAt)
            return `Last backup ${formatDateTime(state.lastFinishedAt)}`;
        return 'Never backed up';
    }

    _updateSidebarProgress(entry, job) {
        const progress = job.state?.progress;
        const display = displayStatus(job.state?.status, progress?.phase);
        if (display === 'checking' || display === 'queued') {
            entry.progress.visible = true;
            entry.progress.pulse();
            return;
        }
        if (display === 'running' && progress) {
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
        const display = job.draft
            ? 'draft'
            : displayStatus(job.state?.status, job.state?.progress?.phase);
        entry.status.set_text(statusLabel(display));
        for (const cssClass of [...entry.status.get_css_classes()]) {
            if (cssClass.startsWith('saveme-job-status-'))
                entry.status.remove_css_class(cssClass);
        }
        entry.status.add_css_class(`saveme-job-status-${display}`);
        setStatusVisual(entry.dot,
            job.draft ? 'draft' : (job.state?.status || 'idle'),
            job.state?.progress?.phase || null);
        const sourceCount = jobSources(job).length;
        entry.typeBadge.set_text(typeLabel(job.type));
        entry.sourcesBadge.set_text(`${sourceCount} source${sourceCount === 1 ? '' : 's'}`);
        entry.sourcesBadge.visible = sourceCount > 1;
        entry.subtitle.set_text(this._sidebarSubtitle(job));
        entry.paths.set_text(this._sidebarPaths(job));
        entry.paths.set_tooltip_text(this._sidebarPaths(job, false));
        entry.row.remove_css_class('saveme-job-draft');
        if (job.draft)
            entry.row.add_css_class('saveme-job-draft');
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
            const recover = new Gtk.Button({
                label: 'Recover backup',
                halign: Gtk.Align.CENTER,
            });
            recover.connect('clicked', () => new RecoverDialog(this.window).present());
            const actions = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 8,
                halign: Gtk.Align.CENTER,
            });
            actions.append(button);
            actions.append(recover);
            page.set_child(actions);
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
            subtitle: job.draft ? 'Draft · continue setup'
                : `${typeLabel(job.type)} · ${statusLabel(state.status)}`,
        });
        const dot = makeStatusVisual(state.status || 'idle');
        statusRow.add_prefix(dot);
        const statusText = job.draft ? 'Draft · continue setup'
            : `${typeLabel(job.type)} · ${statusLabel(state.status)}`;
        statusRow.set_subtitle(statusText);

        const controls = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 4,
            valign: Gtk.Align.CENTER,
        });
        const playButton = iconButton('media-playback-start-symbolic',
            'Start this job now', {cssClasses: ['flat', 'suggested-action']});
        playButton.connect('clicked', () => this._play(job));
        const pauseButton = iconButton('media-playback-pause-symbolic',
            'Pause the current run and its schedule', {cssClasses: ['flat']});
        pauseButton.connect('clicked', () => this._pause(job));
        const stopButton = iconButton('media-playback-stop-symbolic',
            'Stop the current run and its recurrence',
            {cssClasses: ['flat', 'destructive-action']});
        stopButton.connect('clicked', () => this._stop(job));
        const openButton = iconButton('folder-open-symbolic', 'Open destination',
            {cssClasses: ['flat']});
        openButton.connect('clicked', () => this.window.openDestination(job));
        controls.append(playButton);
        controls.append(pauseButton);
        controls.append(stopButton);
        controls.append(openButton);
        statusRow.add_suffix(controls);
        statusGroup.add(statusRow);

        const progressBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 12,
            margin_end: 12,
        });
        const headline = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
        });
        const headlineStatus = new Gtk.Label({
            xalign: 0,
            hexpand: true,
            css_classes: ['title-3'],
        });
        const headlineEta = new Gtk.Label({
            xalign: 1,
            css_classes: ['title-4', 'dim-label'],
        });
        headline.append(headlineStatus);
        headline.append(headlineEta);
        const progress = new Gtk.ProgressBar({
            show_text: false,
            height_request: 16,
            valign: Gtk.Align.CENTER,
        });
        progress.add_css_class('saveme-job-progress');
        const current = new Gtk.Label({
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.END,
            css_classes: ['dim-label'],
            visible: false,
        });
        progressBox.append(headline);
        progressBox.append(progress);
        progressBox.append(current);
        statusGroup.add(progressBox);
        page.add(statusGroup);

        const paths = new Adw.PreferencesGroup({title: 'Source and destination'});
        const sources = jobSources(job);
        for (const [index, source] of sources.entries()) {
            const sourceRow = new Adw.ActionRow({
                title: sources.length > 1 ? `Source ${index + 1}` : 'Source',
                subtitle: descriptorDisplay(source, this.window.volumes),
            });
            const sourceOpen = iconLabelButton('Open', 'folder-open-symbolic', {
                cssClasses: ['flat'],
            });
            sourceOpen.connect('clicked', () => this.window.openSource(job, source));
            sourceRow.add_suffix(sourceOpen);
            paths.add(sourceRow);
        }
        const destinationRow = new Adw.ActionRow({
            title: 'Destination base',
            subtitle: this._destinationLabel(job),
        });
        const destinationOpen = iconLabelButton('Open', 'folder-open-symbolic', {
            cssClasses: ['flat'],
        });
        destinationOpen.connect('clicked', () => this.window.openDestination(job));
        destinationRow.add_suffix(destinationOpen);
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
        } else if (job.destinationLayout !== 'direct') {
            const syncRow = new Adw.ActionRow({
                title: 'Sync folder',
                subtitle: `${backupRootDisplay(job)}/current`,
            });
            const syncOpen = iconLabelButton('Open', 'folder-open-symbolic', {
                cssClasses: ['flat'],
            });
            syncOpen.connect('clicked', () => this.window.openBackupRoot(job));
            syncRow.add_suffix(syncOpen);
            paths.add(syncRow);
        }
        page.add(paths);

        const stats = new Adw.PreferencesGroup({title: 'Statistics'});
        const statsRows = {
            files: this._statRow('Files'),
            data: this._statRow('Data'),
            speed: this._statRow('Speed / ETA'),
            machineCpu: this._statRow('Machine CPU'),
            machineMemory: this._statRow('Machine memory'),
            deletes: this._statRow('Deletes / errors'),
            free: this._statRow('Destination free'),
            last: this._statRow('Last backup'),
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
        if (job.draft) {
            addAction('Continue setup', 'document-edit-symbolic', ['suggested-action'],
                () => this.window.editJob(job));
        }
        const dryRunButton = addAction('Dry run', 'system-run-symbolic', [], () => {
            this.window.client.runJob(job.id, true)
                .then(() => this.window.toast('Dry run started. Check Logs.'))
                .catch(e => this.window.toast(e.message));
        });
        if (job.draft)
            dryRunButton.visible = false;
        if (!job.draft)
            addAction('Edit', 'document-edit-symbolic', [], () => this.window.editJob(job));
        addAction('Logs', 'text-x-generic-symbolic', [], () => this.window.openLogs(job.id));
        if (job.type === JOB_TYPES.BACKUP && !job.draft) {
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
        configuration.add(this._statRow('Schedule', triggerLabel(job.trigger)));
        configuration.add(this._statRow('Delete guard',
            `${job.options.maxDeletePercent}% (minimum ${job.options.maxDeleteMinimum})`));
        if (job.type === JOB_TYPES.BACKUP) {
            configuration.add(this._statRow('Retention',
                job.backup.keepForever || job.backup.retentionDays === 0
                    ? 'keep versions forever'
                    : `${job.backup.retentionDays} days`));
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
            headlineStatus,
            headlineEta,
            destinationRow,
            controls: {playButton, pauseButton, stopButton},
            stats: statsRows,
        };
        this._updateDetails(job);
    }

    _destinationLabel(job) {
        const destination = job.destination;
        let service = 'Local folder';
        if (destination?.kind === 'remote') {
            const remote = (this.window.snapshot?.remotes || [])
                .find(item => item.name === destination.remote);
            service = remote
                ? remoteTypeLabel(remote.type)
                : 'Cloud';
        }
        const path = descriptorDisplay(destination, this.window.volumes) || '-';
        return `${service} · ${path} (base)`;
    }

    _play(job) {
        this.window.client.playJob(job.id)
            .then(() => this.window.toast('Job started.'))
            .catch(e => this.window.toast(cleanError(e.message)));
    }

    _pause(job) {
        this.window.client.pauseJob(job.id, true)
            .then(() => this.window.toast('Job paused.'))
            .catch(e => this.window.toast(cleanError(e.message)));
    }

    _stop(job) {
        this.window.client.cancelJob(job.id)
            .then(() => this.window.toast('Job stopped. Press Play to resume.'))
            .catch(e => this.window.toast(cleanError(e.message)));
    }

    _currentJob() {
        return this.jobs.find(item => item.id === this.selectedId) || null;
    }

    _statRow(title, subtitle = '') {
        return new Adw.ActionRow({title, subtitle});
    }

    _destinationFree(job) {
        if (job.destination?.kind !== 'local')
            return 'cloud';
        try {
            const path = localPathFor(job.destination, this.window.volumes);
            const info = Gio.File.new_for_path(path).query_filesystem_info(
                'filesystem::free', null);
            return formatBytes(Number(info.get_attribute_uint64('filesystem::free')));
        } catch (_) {
            return '-';
        }
    }

    _updateDetails(job) {
        if (!this.detail || this.detail.jobId !== job.id) {
            this._renderDetails();
            return;
        }
        const state = job.state || {};
        const progress = state.progress;
        const last = state.lastStats;
        const display = displayStatus(state.status, progress?.phase);
        this.detail.statusRow.set_subtitle(job.draft
            ? 'Draft · continue setup'
            : `${typeLabel(job.type)} · ${statusLabel(display)}`);
        setStatusVisual(this.detail.dot,
            job.draft ? 'draft' : (state.status || 'idle'),
            progress?.phase || null);
        this.detail.destinationRow.set_subtitle(this._destinationLabel(job));

        const statusName = job.draft ? 'draft' : display;
        this.detail.headlineStatus.set_text(job.draft
            ? 'Draft'
            : statusLabel(display));
        for (const cssClass of [...this.detail.headlineStatus.get_css_classes()]) {
            if (cssClass.startsWith('saveme-job-status-'))
                this.detail.headlineStatus.remove_css_class(cssClass);
        }
        this.detail.headlineStatus.add_css_class(`saveme-job-status-${statusName}`);

        if (display === 'checking' && progress) {
            const listed = Number(progress.listed || 0);
            this.detail.headlineEta.set_text(listed > 0
                ? `${listed.toLocaleString()} files checked`
                : 'Preparing backup…');
            this.detail.progress.visible = true;
            this.detail.progress.pulse();
            const currentPath = progress.currentPath || progress.currentFile;
            if (currentPath) {
                this.detail.current.set_text(truncate(basenameOf(currentPath), 64));
                this.detail.current.set_tooltip_text(currentPath);
                this.detail.current.visible = true;
            } else {
                this.detail.current.visible = false;
            }
        } else if (progress) {
            const parts = [`${Math.round(progress.percent || 0)}%`];
            if (progress.eta !== null && progress.eta !== undefined)
                parts.push(`ETA ${formatEta(progress.eta)}`);
            const speed = Number(progress.speed || 0);
            if (speed > 0)
                parts.push(`${formatBytes(speed)}/s`);
            this.detail.headlineEta.set_text(parts.join(' · '));
            this.detail.progress.visible = true;
            this.detail.progress.set_fraction(
                Math.max(0, Math.min(1, Number(progress.percent || 0) / 100)));
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
            this.detail.headlineEta.set_text(state.status === 'queued'
                ? 'Waiting for a free job slot'
                : state.status === 'running'
                    ? 'Starting…'
                    : state.lastFinishedAt
                        ? `Last backup ${formatWhen(state.lastFinishedAt)}`
                        : '');
            this.detail.progress.visible = false;
            this.detail.progress.set_fraction(0);
            this.detail.current.visible = false;
        }

        this.detail.stats.files.set_subtitle(display === 'checking' && progress
            ? `${Number(progress.listed || 0).toLocaleString()} listed`
            : progress
                ? `${progress.files || 0} / ${progress.totalFiles || 0}`
                : last
                    ? `${last.files || 0} / ${last.totalFiles || last.files || 0}`
                    : '-');
        this.detail.stats.data.set_subtitle(progress
            ? `${formatBytes(progress.bytes)} / ${formatBytes(progress.totalBytes)}`
            : last ? formatBytes(last.bytes) : '-');
        this.detail.stats.speed.set_subtitle(progress
            ? `${formatBytes(progress.speed)}/s · ETA ${formatEta(progress.eta)}`
            : '-');
        const system = this.window.snapshot?.system;
        this.detail.stats.machineCpu.set_subtitle(system?.cpuPercent !== undefined
            ? `${Number(system.cpuPercent).toFixed(1)}%`
            : '-');
        this.detail.stats.machineMemory.set_subtitle(system?.memory
            ? `${formatBytes(system.memory.usedBytes)} / ` +
                `${formatBytes(system.memory.totalBytes)}`
            : '-');
        this.detail.stats.deletes.set_subtitle(progress
            ? `${progress.deletes || 0} / ${progress.errors || 0}`
            : last ? `${last.deletes || 0} / ${last.errors || 0}` : '-');
        this.detail.stats.free.set_subtitle(this._destinationFree(job));
        const finished = state.lastFinishedAt || state.lastRunAt;
        this.detail.stats.last.set_subtitle(finished
            ? `${formatDateTime(finished)} · ` +
                `${RESULT_LABELS[state.lastResult] || state.lastResult || '-'}`
            : 'never');
        this.detail.stats.message.set_subtitle(state.message || '');
        this.detail.stats.message.visible = Boolean(state.message);

        const draft = Boolean(job.draft);
        const running = state.status === 'running' && !draft;
        const queued = state.status === 'queued' && !draft;
        const paused = Boolean(state.paused);
        const stopped = Boolean(state.stopped);
        const usable = !draft && job.enabled !== false;
        this.detail.controls.playButton.visible = !draft;
        this.detail.controls.pauseButton.visible = !draft;
        this.detail.controls.stopButton.visible = !draft;
        this.detail.controls.playButton.sensitive = usable && !running && !queued;
        this.detail.controls.pauseButton.sensitive = usable && !paused && !stopped;
        this.detail.controls.stopButton.sensitive = usable && !stopped;
    }
}
