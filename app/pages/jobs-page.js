import Pango from 'gi://Pango';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import {JOB_TYPES, descriptorDisplay, jobSources, localPathFor} from '../../src/jobs.js';
import {triggerLabel} from '../../src/domain/schedule.js';
import {t} from '../../src/i18n.js';
import {RecoverDialog} from '../recover-dialog.js';
import {DryRunDialog} from '../dry-run-dialog.js';
import {JobLogsDialog} from '../job-logs-dialog.js';
import {probeFolderSize} from '../size-probe.js';
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

const PROBLEM_STATUSES = new Set([
    'error', 'offline', 'no-space', 'needs-auth', 'delete-guard',
    'waiting-source', 'waiting-destination',
]);

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
        this.appMetrics = null;
        this._sizeCache = new Map();
        this._sizePending = new Set();
        this._displayStates = new Map();

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
            label: t('Jobs'),
            xalign: 0,
            hexpand: true,
            css_classes: ['heading'],
        }));
        const add = iconLabelButton(t('New job'), 'list-add-symbolic', {
            cssClasses: ['suggested-action'],
        });
        add.connect('clicked', () => this.window.newJob());
        header.append(add);
        const find = iconLabelButton(t('Find jobs'),
            'system-search-symbolic', {cssClasses: ['flat']});
        find.connect('clicked', () =>
            new RecoverDialog(this.window, {mode: 'import'}).present());
        header.append(find);
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

        this.metricsBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 10,
            margin_top: 4,
            margin_bottom: 8,
            margin_start: 8,
            margin_end: 8,
            halign: Gtk.Align.CENTER,
        });
        const cpu = this._metricItem('utilities-system-monitor-symbolic',
            t('Application CPU'));
        this.cpuMetric = cpu.label;
        const memory = this._metricItem('drive-harddisk-symbolic',
            t('Application memory'));
        this.memoryMetric = memory.label;
        const network = this._metricItem('network-transmit-receive-symbolic',
            t('Transfer speed'));
        this.networkMetric = network.label;
        this.metricsBox.append(cpu.box);
        this.metricsBox.append(memory.box);
        this.metricsBox.append(network.box);
        sidebar.append(this.metricsBox);
        this.widget.set_start_child(sidebar);
        this.sidebar = sidebar;
    }

    update(snapshot) {
        const rawJobs = snapshot.jobs || [];
        const jobs = rawJobs.map(job => {
            const state = job.state || {};
            if (state.dryRun) {
                const previous = this._displayStates.get(job.id);
                return {
                    ...job,
                    state: previous || {status: 'idle', progress: null},
                };
            }
            this._displayStates.set(job.id, {
                ...state,
                progress: state.progress ? {...state.progress} : null,
            });
            return job;
        });
        this.jobs = jobs;
        if (!jobs.some(job => job.id === this.selectedId))
            this.selectedId = jobs[0]?.id || null;

        const key = jobs.map(job => [
            job.id,
            job.name,
            job.type,
            job.enabled,
            JSON.stringify(job.options),
            JSON.stringify(job.backup),
            JSON.stringify(job.filters),
            JSON.stringify(job.trigger),
            JSON.stringify(job.sources),
            JSON.stringify(job.destination),
            job.destinationLayout,
        ].join(':')).join('|');
        const structureChanged = key !== this.structureKey;
        if (structureChanged) {
            this.structureKey = key;
            this._rebuildSidebar();
        } else {
            for (const job of jobs)
                this._updateSidebarRow(job);
        }

        const job = jobs.find(item => item.id === this.selectedId) || null;
        this._updateMetrics(snapshot);
        if (structureChanged || this.detailsJobId !== this.selectedId || !this.detail)
            this._renderDetails();
        else if (job)
            this._updateDetails(job);
    }

    updatePerformance(metrics) {
        this.appMetrics = metrics;
        this._updateMetrics(this.window.snapshot);
    }

    _metricItem(iconName, tooltip) {
        const box = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 4});
        box.append(new Gtk.Image({icon_name: iconName, pixel_size: 14}));
        const label = new Gtk.Label({
            label: '-',
            css_classes: ['caption'],
        });
        box.append(label);
        box.set_tooltip_text(tooltip);
        return {box, label};
    }

    _updateMetrics(snapshot) {
        if (!this.cpuMetric)
            return;
        const metrics = this.appMetrics;
        this.cpuMetric.set_text(metrics
            ? `${Number(metrics.cpuPercent || 0).toFixed(1)}%`
            : '0.0%');
        this.memoryMetric.set_text(metrics
            ? formatBytes(metrics.rssBytes)
            : '0.0 MiB');
        let speed = 0;
        for (const job of snapshot?.jobs || []) {
            const progress = job.state?.progress;
            if (!progress)
                continue;
            if (!['running', 'checking', 'finalizing'].includes(job.state?.status))
                continue;
            speed += Number(progress.speed || 0);
        }
        this.networkMetric.set_text(
            speed > 0 ? `${formatBytes(speed)}/s` : '0.0 B/s');
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
            label: sourceCount === 1
                ? `1 ${t('source')}`
                : `${sourceCount} ${t('sources')}`,
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
            return t('Draft · continue setup');
        const state = job.state || {};
        const progress = state.progress;
        const display = displayStatus(state.status, progress?.phase);
        if (PROBLEM_STATUSES.has(display) && String(state.message || '').trim())
            return truncate(state.message, 90);
        if (display === 'checking') {
            const listed = Number(progress?.listed || 0);
            return listed > 0
                ? `${t('Checking')} · ${listed.toLocaleString()} ${t('files')}`
                : `${t('Checking')} · ${t(job.type === JOB_TYPES.BACKUP
                    ? 'Preparing backup' : 'Preparing sync')}`;
        }
        if (display === 'running' && progress) {
            return `${Math.round(progress.percent || 0)}% · ` +
                `${formatBytes(progress.bytes)} / ${formatBytes(progress.totalBytes)}`;
        }
        if (display === 'finalizing')
            return `${t('Finalizing')} · ${t('cleaning versions')}`;
        if (display === 'queued')
            return `${t('Queued')} · ${t('waiting for a free slot')}`;
        if (state.lastFinishedAt)
            return `${t('Last backup')} ${formatDateTime(state.lastFinishedAt)}`;
        return t('Never backed up');
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
        entry.sourcesBadge.set_text(sourceCount === 1
            ? `1 ${t('source')}`
            : `${sourceCount} ${t('sources')}`);
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
                title: t('No jobs configured'),
                description: t('Create a job to start syncing.'),
                icon_name: 'view-list-symbolic',
            });
            const actions = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 12,
                homogeneous: true,
                halign: Gtk.Align.CENTER,
            });
            const addAction = (iconName, title, help, cssClasses, callback) => {
                const content = new Gtk.Box({
                    orientation: Gtk.Orientation.VERTICAL,
                    spacing: 6,
                    margin_top: 14,
                    margin_bottom: 14,
                    margin_start: 12,
                    margin_end: 12,
                    halign: Gtk.Align.CENTER,
                });
                content.append(new Gtk.Image({
                    icon_name: iconName,
                    pixel_size: 32,
                    halign: Gtk.Align.CENTER,
                }));
                content.append(new Gtk.Label({
                    label: title,
                    xalign: 0.5,
                    justify: Gtk.Justification.CENTER,
                    css_classes: ['title-3'],
                }));
                content.append(new Gtk.Label({
                    label: help,
                    xalign: 0.5,
                    justify: Gtk.Justification.CENTER,
                    wrap: true,
                    max_width_chars: 24,
                    css_classes: ['dim-label'],
                }));
                const button = new Gtk.Button({
                    child: content,
                    width_request: 190,
                    height_request: 130,
                    css_classes: ['card', ...cssClasses],
                });
                button.connect('clicked', callback);
                actions.append(button);
            };
            addAction('list-add-symbolic', t('New job'),
                t('Create a job to start syncing.'), ['suggested-action'],
                () => this.window.newJob());
            addAction('system-search-symbolic', t('Find your jobs'),
                t('Select your existing SaveMe folders'), [],
                () => new RecoverDialog(this.window, {mode: 'import'}).present());
            addAction('document-revert-symbolic', t('Restore'),
                t('Recover your data.'), [],
                () => new RecoverDialog(this.window, {mode: 'restore'}).present());
            page.set_child(actions);
            scroll.set_child(page);
            return;
        }

        const page = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 18,
            margin_top: 18,
            margin_bottom: 18,
            margin_start: 12,
            margin_end: 12,
        });
        const clamp = new Adw.Clamp({
            maximum_size: 900,
            tightening_threshold: 650,
            child: page,
        });
        scroll.set_child(clamp);

        const state = job.state || {};
        const statusGroup = new Adw.PreferencesGroup({title: t('Status')});
        const statusRow = new Adw.ActionRow({
            title: job.name || job.id,
            subtitle: job.draft ? t('Draft · continue setup')
                : `${typeLabel(job.type)} · ${statusLabel(state.status)}`,
        });
        const dot = makeStatusVisual(state.status || 'idle');
        statusRow.add_prefix(dot);

        const controls = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 4,
            valign: Gtk.Align.CENTER,
        });
        const playButton = iconButton('media-playback-start-symbolic',
            t('Start this job now'), {cssClasses: ['flat', 'suggested-action']});
        playButton.connect('clicked', () => this._play(job));
        const pauseButton = iconButton('media-playback-pause-symbolic',
            t('Pause the current run and its schedule'), {cssClasses: ['flat']});
        pauseButton.connect('clicked', () => this._pause(job));
        const stopButton = iconButton('media-playback-stop-symbolic',
            t('Stop the current run and its recurrence'),
            {cssClasses: ['flat', 'destructive-action']});
        stopButton.connect('clicked', () => this._stop(job));
        controls.append(playButton);
        controls.append(pauseButton);
        controls.append(stopButton);
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
        const message = new Gtk.Label({
            xalign: 0,
            wrap: true,
            visible: false,
            css_classes: ['saveme-job-message'],
        });
        progressBox.append(headline);
        progressBox.append(progress);
        progressBox.append(current);
        progressBox.append(message);
        statusGroup.add(progressBox);
        page.append(statusGroup);

        page.append(this._sourceGroup(job));
        page.append(this._contentGroup(job));
        page.append(this._destinationGroup(job));
        page.append(this._localGroup(job));
        page.append(this._actionsSection(job));
        page.append(this._configurationSection(job));
        const stats = this._statisticsSection(job);
        page.append(stats.group);

        this.detail = {
            jobId: job.id,
            statusRow,
            dot,
            progress,
            current,
            message,
            headlineStatus,
            headlineEta,
            destinationRow: this._baseRow,
            controls: {playButton, pauseButton, stopButton},
            stats: stats.rows,
        };
        this._updateDetails(job);
        this._refreshJobSize(job);
    }

    _sourceGroup(job) {
        const sources = jobSources(job);
        const source = sources[0] || job.source;
        const group = new Adw.PreferencesGroup({title: t('Origem')});
        if (source) {
            const remote = source.kind === 'remote'
                ? (this.window.snapshot?.remotes || [])
                    .find(item => item.name === source.remote)
                : null;
            const row = new Adw.ActionRow({
                title: descriptorDisplay(source, this.window.volumes) || '-',
                subtitle: source.kind === 'remote'
                    ? remoteTypeLabel(remote?.type || 'cloud')
                    : t('Local folder'),
            });
            const open = iconLabelButton(t('Open'), 'folder-open-symbolic', {
                cssClasses: ['flat'],
            });
            open.connect('clicked', () => this.window.openSource(job, source));
            row.add_suffix(open);
            group.add(row);
        }
        if (sources.length > 1) {
            group.add(new Adw.ActionRow({
                title: t('Legacy job with {count} sources', {count: sources.length}),
                subtitle: t('This older job still has multiple sources. Edit it to review.'),
            }));
        }
        return group;
    }

    _contentGroup(job) {
        const group = new Adw.PreferencesGroup({title: t('Conteúdo')});
        const includes = job.filters?.include || [];
        if (includes.length === 0) {
            group.add(new Adw.ActionRow({
                title: t('All source content'),
                subtitle: t('Everything below the source folder.'),
            }));
        } else {
            for (const path of includes) {
                group.add(new Adw.ActionRow({
                    title: path,
                    subtitle: t('Selected content'),
                }));
            }
        }
        const excludes = job.filters?.exclude || [];
        if (excludes.length > 0) {
            group.add(new Adw.ActionRow({
                title: t('Exclusion filters'),
                subtitle: excludes.join(', '),
            }));
        }
        return group;
    }

    _destinationGroup(job) {
        const destination = job.destination;
        const remote = destination?.kind === 'remote'
            ? (this.window.snapshot?.remotes || [])
                .find(item => item.name === destination.remote)
            : null;
        this._baseRow = new Adw.ActionRow({
            title: destination?.kind === 'remote'
                ? remoteTypeLabel(remote?.type || 'cloud')
                : t('Local disk'),
            subtitle: descriptorDisplay(destination, this.window.volumes) || '-',
        });
        const baseOpen = iconLabelButton(t('Open'), 'folder-open-symbolic', {
            cssClasses: ['flat'],
        });
        baseOpen.connect('clicked', () => this.window.openDestination(job));
        this._baseRow.add_suffix(baseOpen);
        this._addRemoteWebButton(this._baseRow, job, destination?.path || '');
        const group = new Adw.PreferencesGroup({title: t('Pasta SaveMe')});
        group.add(this._baseRow);
        return group;
    }

    _localGroup(job) {
        const destination = job.destination;
        const direct = job.destinationLayout === 'direct';
        const jobPath = direct
            ? descriptorDisplay(destination, this.window.volumes)
            : `${backupRootDisplay(job)}${job.type === JOB_TYPES.SYNC ? '/current' : ''}`;
        const service = direct
            ? t('Legacy direct destination')
            : job.type === JOB_TYPES.BACKUP
                ? t('Backup folder') : t('Sync folder');
        const row = new Adw.ActionRow({
            title: service,
            subtitle: jobPath || '-',
        });
        const open = iconLabelButton(t('Open'), 'folder-open-symbolic', {
            cssClasses: ['flat'],
        });
        open.connect('clicked', () => direct
            ? this.window.openDestination(job)
            : this.window.openBackupRoot(job));
        row.add_suffix(open);
        if (!direct)
            this._addRemoteWebButton(row, job, this._jobFolderPath(job));
        const group = new Adw.PreferencesGroup({title: t('Pasta do Job')});
        group.add(row);
        return group;
    }

    _actionsSection(job) {
        const group = new Adw.PreferencesGroup({title: t('Ações')});
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
            addAction(t('Continue setup'), 'document-edit-symbolic', ['suggested-action'],
                () => this.window.editJob(job));
        } else {
            if (job.type === JOB_TYPES.BACKUP) {
                addAction(t('Simulação'), 'system-run-symbolic', [],
                    () => new DryRunDialog(this.window, job).present());
            }
            addAction(t('Edit'), 'document-edit-symbolic', [], () => this.window.editJob(job));
            addAction(t('Logs'), 'text-x-generic-symbolic', [],
                () => new JobLogsDialog(this.window, job).present());
            if (job.type === JOB_TYPES.BACKUP) {
                addAction(t('Restore'), 'document-revert-symbolic',
                    ['suggested-action'], () => this.window.openVersions(job));
            }
        }
        addAction(t('Delete'), 'edit-delete-symbolic', ['destructive-action'],
            () => this._confirmDeleteJob(job));
        group.add(flow);
        return group;
    }

    _configurationSection(job) {
        const group = new Adw.PreferencesGroup({title: t('Configuração')});
        group.add(this._configRow(t('Schedule'), triggerLabel(job.trigger),
            t('When this job runs automatically.')));
        if (job.type === JOB_TYPES.BACKUP) {
            group.add(this._deleteGuardRow(job));
            group.add(this._configRow(t('Retention'),
                job.backup.keepForever || job.backup.retentionDays === 0
                    ? t('keep versions forever')
                    : `${job.backup.retentionDays} ${t('days')}`,
                t('How long old versions are kept before cleanup.')));
        }
        const excludes = job.filters?.exclude || [];
        if (excludes.length > 0) {
            group.add(this._configRow(t('Excludes'), excludes.join(', '),
                t('Files matching these patterns are never copied.')));
        }
        return group;
    }

    _deleteGuardRow(job) {
        const enabled = job.options.deleteGuardEnabled !== false;
        const row = new Adw.ActionRow({
            title: t('Delete guard'),
            subtitle: t('A run is stopped if it would delete more files than this limit.'),
        });
        const value = new Gtk.Button({
            label: enabled
                ? `${job.options.maxDeletePercent}% (min ${job.options.maxDeleteMinimum})`
                : t('Disabled'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: t('Change the deletion limits'),
        });
        value.sensitive = enabled;
        value.connect('clicked', () => this._editDeleteGuardLimits(job));
        const toggle = new Gtk.Switch({
            active: enabled,
            valign: Gtk.Align.CENTER,
            tooltip_text: enabled ? t('Disable delete guard') : t('Enable delete guard'),
        });
        let busy = false;
        toggle.connect('notify::active', async () => {
            if (busy)
                return;
            busy = true;
            const next = toggle.active;
            try {
                await this.window.client.setJobOptions(job.id, {
                    deleteGuardEnabled: next,
                });
                await this.window.refresh();
                this.window.toast(t('Delete guard updated.'));
            } catch (e) {
                toggle.active = !next;
                this.window.toast(cleanError(e.message));
            } finally {
                busy = false;
            }
        });
        const controls = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            valign: Gtk.Align.CENTER,
        });
        controls.append(value);
        controls.append(toggle);
        row.add_suffix(controls);
        return row;
    }

    _editDeleteGuardLimits(job) {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
        });
        const percent = new Adw.SpinRow({
            title: t('Maximum deletion (%)'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 100,
                step_increment: 1,
                page_increment: 10,
                value: Number(job.options.maxDeletePercent ?? 10),
            }),
        });
        const minimum = new Adw.SpinRow({
            title: t('Minimum deletion allowance (files)'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 100000,
                step_increment: 1,
                page_increment: 10,
                value: Number(job.options.maxDeleteMinimum ?? 10),
            }),
        });
        box.append(percent);
        box.append(minimum);
        const dialog = new Adw.AlertDialog({
            heading: t('Delete guard'),
            body: t('Stop a backup when it would delete too many files.'),
        });
        dialog.set_extra_child(box);
        dialog.add_response('cancel', t('Cancel'));
        dialog.add_response('save', t('Save'));
        dialog.set_response_appearance('save', Adw.ResponseAppearance.SUGGESTED);
        dialog.set_default_response('save');
        dialog.set_close_response('cancel');
        dialog.connect('response', (_dialog, response) => {
            if (response !== 'save')
                return;
            this._saveDeleteGuard(job, {
                maxDeletePercent: Math.round(percent.value),
                maxDeleteMinimum: Math.round(minimum.value),
            });
        });
        dialog.present(this.window);
    }

    async _saveDeleteGuard(job, options) {
        try {
            await this.window.client.setJobOptions(job.id, options);
            await this.window.refresh();
            this.window.toast(t('Delete guard updated.'));
        } catch (e) {
            this.window.toast(cleanError(e.message));
        }
    }

    _configRow(title, value, help) {
        const row = new Adw.ActionRow({title, subtitle: help});
        row.add_suffix(new Gtk.Label({
            label: value,
            xalign: 1,
            halign: Gtk.Align.END,
            valign: Gtk.Align.CENTER,
            wrap: false,
            css_classes: ['dim-label'],
        }));
        return row;
    }

    _statisticsSection(job) {
        const group = new Adw.PreferencesGroup({title: t('Estatísticas')});
        const size = new Adw.ActionRow({
            title: t('Total occupied'),
            subtitle: t('Calculating…'),
        });
        const last = new Adw.ActionRow({
            title: job.type === JOB_TYPES.BACKUP
                ? t('Last backup') : t('Last sync'),
            subtitle: t('Never backed up'),
        });
        group.add(size);
        group.add(last);
        return {group, rows: {size, last}};
    }

    _refreshJobSize(job) {
        if (!this.detail || this.detail.jobId !== job.id || !this.detail.stats.size)
            return;
        const state = job.state || {};
        const key = `${job.id}:${state.lastFinishedAt || ''}:` +
            `${job.destination?.remote || ''}:${job.destination?.path || ''}`;
        const cached = this._sizeCache.get(key);
        if (cached !== undefined) {
            this.detail.stats.size.set_subtitle(cached);
            return;
        }
        if (this._sizePending.has(key))
            return;
        const destination = job.destination;
        let path;
        if (destination?.kind === 'local') {
            const base = localPathFor(destination, this.window.volumes);
            if (!base) {
                this.detail.stats.size.set_subtitle('-');
                return;
            }
            path = job.destinationLayout === 'direct'
                ? base
                : `${base.replace(/\/+$/, '')}/SaveMe/${job.id}`;
        } else if (destination?.kind === 'remote') {
            const base = String(destination.path || '').replace(/^\/+|\/+$/g, '');
            const root = base ? `${base}/SaveMe/${job.id}` : `SaveMe/${job.id}`;
            path = job.destinationLayout === 'direct'
                ? `${destination.remote}:${base}`
                : `${destination.remote}:${root}`;
        }
        if (!path) {
            this.detail.stats.size.set_subtitle('-');
            return;
        }
        this._sizePending.add(key);
        probeFolderSize(path)
            .then(result => {
                const text = formatBytes(result.bytes || 0);
                this._sizeCache.set(key, text);
                if (this.detail?.jobId === job.id && this.detail.stats.size)
                    this.detail.stats.size.set_subtitle(text);
            })
            .catch(() => {
                if (this.detail?.jobId === job.id && this.detail.stats.size)
                    this.detail.stats.size.set_subtitle('-');
            })
            .finally(() => this._sizePending.delete(key));
    }

    _jobFolderPath(job) {
        const suffix = job.type === JOB_TYPES.BACKUP
            ? `SaveMe/${job.id}`
            : `SaveMe/${job.id}/current`;
        const base = String(job.destination?.path || '').replace(/^\/+|\/+$/g, '');
        return base ? `${base}/${suffix}` : suffix;
    }

    _remoteWebUrl(job, relativePath = '') {
        const destination = job.destination;
        if (destination?.kind !== 'remote')
            return null;
        const remote = (this.window.snapshot?.remotes || [])
            .find(item => item.name === destination.remote);
        const type = remote?.type;
        const path = String(relativePath || '').replace(/^\/+|\/+$/g, '');
        const encoded = path.split('/').filter(Boolean)
            .map(part => encodeURIComponent(part)).join('/');
        if (type === 'dropbox')
            return `https://www.dropbox.com/home/${encoded}`;
        if (type === 'drive') {
            return 'https://drive.google.com/drive/search?q=' +
                encodeURIComponent(path || 'SaveMe');
        }
        return null;
    }

    _addRemoteWebButton(row, job, relativePath) {
        if (job.destination?.kind !== 'remote')
            return;
        const remote = (this.window.snapshot?.remotes || [])
            .find(item => item.name === job.destination.remote);
        const type = remote?.type;
        if (!['dropbox', 'drive', 'onedrive'].includes(type))
            return;
        const button = iconButton('web-browser-symbolic',
            `Open in ${remoteTypeLabel(type || 'cloud')}`,
            {cssClasses: ['flat'], pixelSize: 18});
        button.connect('clicked', async () => {
            button.sensitive = false;
            try {
                let url = this._remoteWebUrl(job, relativePath);
                if (!url && type === 'onedrive')
                    url = await this.window.client.remoteWebUrl(
                        job.destination.remote, relativePath);
                if (!url)
                    throw new Error(t('No web link is available for this folder.'));
                Gio.AppInfo.launch_default_for_uri(url, null);
            } catch (e) {
                this.window.toast(t('Cannot open cloud folder: {message}', {
                    message: cleanError(e.message),
                }));
            } finally {
                button.sensitive = true;
            }
        });
        row.add_suffix(button);
    }

    _play(job) {
        this.window.client.playJob(job.id)
            .then(() => this.window.toast(t('Job started.')))
            .catch(e => this.window.toast(cleanError(e.message)));
    }

    _pause(job) {
        this.window.client.pauseJob(job.id, true)
            .then(() => this.window.toast(t('Job paused.')))
            .catch(e => this.window.toast(cleanError(e.message)));
    }

    _stop(job) {
        this.window.client.cancelJob(job.id)
            .then(() => this.window.toast(t('Job stopped. Press Play to resume.')))
            .catch(e => this.window.toast(cleanError(e.message)));
    }

    _confirmDeleteJob(job) {
        const destination = job.destination;
        const canDeleteData = job.destinationLayout !== 'direct' &&
            Boolean(destination?.path || destination?.remote);
        const dialog = new Adw.AlertDialog({
            heading: t('Delete job?'),
            body: `${t('Delete')} “${job.name}”? ${t('The job configuration is removed.')} ` +
                (canDeleteData
                    ? t('The destination folder is kept unless you select the option below.')
                    : t('The destination files are kept.')),
        });
        let deleteDataCheck = null;
        if (canDeleteData) {
            const box = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 6,
            });
            deleteDataCheck = new Gtk.CheckButton({
                label: t('Also delete this job’s folder in the destination'),
            });
            box.append(deleteDataCheck);
            dialog.set_extra_child(box);
        }
        dialog.add_response('cancel', t('Cancel'));
        dialog.add_response('delete', t('Delete'));
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.connect('response', (_dialog, response) => {
            if (response !== 'delete')
                return;
            const deleteData = Boolean(deleteDataCheck?.active);
            this.window.client.deleteJob(job.id, deleteData)
                .then(() => this.window.toast(deleteData
                    ? t('Job and destination folder deleted.')
                    : t('Job deleted.')))
                .catch(e => this.window.toast(cleanError(e.message)));
        });
        dialog.present(this.window);
    }

    _updateDetails(job) {
        if (!this.detail || this.detail.jobId !== job.id) {
            this._renderDetails();
            return;
        }
        const state = job.state || {};
        const progress = state.progress;
        const display = displayStatus(state.status, progress?.phase);
        this.detail.statusRow.set_subtitle(job.draft
            ? 'Draft · continue setup'
            : `${typeLabel(job.type)} · ${statusLabel(display)}`);
        setStatusVisual(this.detail.dot,
            job.draft ? 'draft' : (state.status || 'idle'),
            progress?.phase || null);

        const statusName = job.draft ? 'draft' : display;
        this.detail.headlineStatus.set_text(job.draft
            ? 'Draft'
            : statusLabel(display));
        for (const cssClass of [...this.detail.headlineStatus.get_css_classes()]) {
            if (cssClass.startsWith('saveme-job-status-'))
                this.detail.headlineStatus.remove_css_class(cssClass);
        }
        this.detail.headlineStatus.add_css_class(`saveme-job-status-${statusName}`);

        const stateMessage = String(state.message || '').trim();
        this.detail.message.set_text(stateMessage);
        this.detail.message.visible = Boolean(stateMessage) &&
            PROBLEM_STATUSES.has(state.status);

        if (display === 'checking' && progress) {
            const listed = Number(progress.listed || 0);
            this.detail.headlineEta.set_text(listed > 0
                ? `${listed.toLocaleString()} ${t('files checked')}`
                : `${t(job.type === JOB_TYPES.BACKUP
                    ? 'Preparing backup' : 'Preparing sync')}…`);
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
                ? t('Waiting for a free job slot')
                : state.status === 'running'
                    ? t('Starting…')
                    : state.lastFinishedAt
                        ? `${t('Last backup')} ${formatWhen(state.lastFinishedAt)}`
                        : '');
            this.detail.progress.visible = false;
            this.detail.progress.set_fraction(0);
            this.detail.current.visible = false;
        }

        const finished = state.lastFinishedAt || state.lastRunAt;
        this.detail.stats.last.set_subtitle(finished
            ? `${formatDateTime(finished)} · ` +
                `${t(RESULT_LABELS[state.lastResult] || state.lastResult || '-')}`
            : job.type === JOB_TYPES.BACKUP ? t('Never backed up') : t('Never synced'));
        if (this.detail.stats.size)
            this._refreshJobSize(job);

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
