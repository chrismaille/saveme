import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {VolumeResolver} from '../src/volumes.js';
import {AccountDialog} from './account-dialog.js';
import {AccountsDialog} from './accounts-dialog.js';
import {RemoteBrowserDialog} from './remote-browser.js';
import {
    JOB_TYPES,
    TRIGGER_MODES,
    defaultJob,
    descriptorDisplay,
    descriptorKey,
    normalizeJob,
    validateJob,
} from '../src/jobs.js';
import {INTERVAL_UNITS, WEEKDAYS, isValidTime} from '../src/domain/schedule.js';
import {cleanError, remoteTypeLabel} from './presentation/format.js';

const TRIGGER_OPTIONS = [
    {mode: TRIGGER_MODES.REALTIME, label: 'Real-time'},
    {mode: TRIGGER_MODES.INTERVAL, label: 'Interval'},
    {mode: TRIGGER_MODES.WEEKLY, label: 'Weekly'},
    {mode: TRIGGER_MODES.MONTHLY, label: 'Monthly'},
    {mode: TRIGGER_MODES.STARTUP, label: 'At computer startup'},
    {mode: TRIGGER_MODES.DUSK, label: 'At dusk'},
    {mode: TRIGGER_MODES.MANUAL, label: 'Manual'},
];
const STEP_TITLES = ['General', 'Sources', 'Destination', 'Schedule', 'Safety'];

export const JobEditor = GObject.registerClass({
    GTypeName: 'SaveMeJobEditor',
}, class JobEditor extends Adw.Window {
    constructor(parentWindow, job = null) {
        super({
            transient_for: parentWindow,
            modal: true,
            title: job?.draft ? 'Continue job' : job ? 'Edit job' : 'New job',
            default_width: 720,
            default_height: 700,
        });
        this.parentWindow = parentWindow;
        this.client = parentWindow.client;
        this.volumes = parentWindow.volumes || new VolumeResolver();
        this.isNew = !job || job.draft;
        this.isDraft = Boolean(job?.draft);
        this._draftPromise = null;
        this._draftQueuedStep = 0;
        this._ready = false;
        this._saved = false;
        this._closing = false;
        this._saving = false;
        this.job = normalizeJob(job
            ? JSON.parse(JSON.stringify(job))
            : defaultJob());
        delete this.job.state;
        this.sources = (this.job.sources?.length ? this.job.sources : [this.job.source])
            .filter(Boolean)
            .map(source => JSON.parse(JSON.stringify(source)));
        if (this.sources.length === 0)
            this.sources.push({kind: 'local', path: ''});
        this._step = this.job.draft ? this.job.draftStep : 0;
        this._build();
    }

    _build() {
        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        this.windowTitle = new Adw.WindowTitle({title: this.title});
        header.set_title_widget(this.windowTitle);

        const cancel = new Gtk.Button({label: 'Cancel'});
        this.cancelButton = cancel;
        cancel.connect('clicked', () => this.close());
        header.pack_start(cancel);
        this.backButton = new Gtk.Button({
            icon_name: 'go-previous-symbolic',
            tooltip_text: 'Back',
            css_classes: ['flat'],
        });
        this.backButton.connect('clicked', () => this._showStep(this._step - 1));
        header.pack_start(this.backButton);

        this.nextButton = new Gtk.Button({
            label: 'Next',
            css_classes: ['suggested-action'],
        });
        this.nextButton.connect('clicked', () => this._next());
        header.pack_end(this.nextButton);
        this.saveButton = new Gtk.Button({label: 'Save'});
        this.saveButton.connect('clicked', () => this._save(false));
        header.pack_end(this.saveButton);
        this.runButton = new Gtk.Button({
            label: 'Save & Run',
            css_classes: ['suggested-action'],
        });
        this.runButton.connect('clicked', () => this._save(true));
        header.pack_end(this.runButton);
        toolbar.add_top_bar(header);

        this.stack = new Adw.ViewStack();
        this.stack.add_titled(this._buildGeneralPage(), 'general', STEP_TITLES[0]);
        this.stack.add_titled(this._buildSourcesPage(), 'sources', STEP_TITLES[1]);
        this.stack.add_titled(this._buildDestinationPage(), 'destination', STEP_TITLES[2]);
        this.stack.add_titled(this._buildSchedulePage(), 'schedule', STEP_TITLES[3]);
        this.stack.add_titled(this._buildSafetyPage(), 'safety', STEP_TITLES[4]);
        toolbar.set_content(this.stack);
        this.set_content(toolbar);
        this._updateVisibility();
        this._showStep(this._step);
        this._ready = true;
        this.connect('close-request', () => {
            if (!this._saved && !this._saving && this._step >= 1)
                this._closing = true;
            if (!this._saved && !this._saving)
                this._autosaveDraft(this._step);
            return false;
        });
    }

    _page() {
        return new Adw.PreferencesPage();
    }

    _buildGeneralPage() {
        const page = this._page();
        const group = new Adw.PreferencesGroup({
            title: 'General',
            description: this.isNew
                ? 'Name the job and choose whether it mirrors or keeps versions.'
                : 'The job type cannot be changed after creation.',
        });
        this.nameRow = new Adw.EntryRow({
            title: 'Name',
            text: this.job.name || '',
        });
        this.typeRow = new Adw.ComboRow({
            title: 'Type',
            model: Gtk.StringList.new(['Sync', 'Backup']),
            selected: this.job.type === JOB_TYPES.BACKUP ? 1 : 0,
        });
        this.typeRow.sensitive = this.isNew;
        this.typeRow.connect('notify::selected', () => this._updateVisibility());
        group.add(this.nameRow);
        group.add(this.typeRow);
        page.add(group);
        return page;
    }

    _buildSourcesPage() {
        const page = this._page();
        this.sourcesGroup = new Adw.PreferencesGroup({
            title: 'Sources',
            description: 'Backup can combine multiple local folders. Sync uses one source.',
        });
        this.sourceRows = [];
        this.addSourceRow = new Adw.ActionRow({
            title: 'Add another source',
            subtitle: 'Combine another folder in this backup.',
        });
        const add = new Gtk.Button({
            label: 'Add',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        add.connect('clicked', () => this._addSource());
        this.addSourceRow.add_suffix(add);
        this.addSourceAttached = false;
        this._renderSources();
        page.add(this.sourcesGroup);

        const filters = new Adw.PreferencesGroup({title: 'Filters'});
        this.filtersRow = new Adw.EntryRow({
            title: 'Exclude patterns (comma-separated)',
            text: (this.job.filters.exclude || []).join(', '),
        });
        filters.add(this.filtersRow);
        page.add(filters);
        return page;
    }

    _buildDestinationPage() {
        const page = this._page();
        this.existingGroup = new Adw.PreferencesGroup({
            title: 'Destinations in use',
            description: 'Reuse a base folder from another job, or create a new destination.',
        });
        this.existingRows = [];
        this.destinations = this._usedDestinations();
        this._destinationMode = this.destinations.length > 0 ? 'existing' : 'new';
        page.add(this.existingGroup);

        const group = new Adw.PreferencesGroup({
            title: 'New destination',
            description: 'Choose the provider and the base folder. SaveMe creates its own job folder inside that base; several jobs can share the same base.',
        });
        this.newDestinationGroup = group;
        this.providerButtons = new Map();
        const providers = [
            ['local', 'Local folder', 'drive-harddisk-symbolic'],
            ['dropbox', 'Dropbox', 'folder-remote-symbolic'],
            ['onedrive', 'OneDrive', 'folder-remote-symbolic'],
            ['drive', 'Google Drive', 'folder-remote-symbolic'],
        ];
        const flow = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE,
            max_children_per_line: 4,
            column_spacing: 8,
            row_spacing: 8,
            homogeneous: true,
            margin_top: 8,
            margin_bottom: 8,
        });
        for (const [kind, label, icon] of providers) {
            const button = new Gtk.Button({
                height_request: 72,
                hexpand: true,
                css_classes: ['pill'],
                child: new Adw.ButtonContent({icon_name: icon, label}),
            });
            button.connect('clicked', () => {
                if (kind === 'local')
                    this._pickLocalFolder(descriptor => this._setDestination(descriptor));
                else
                    this._pickProvider(kind);
            });
            flow.append(button);
            this.providerButtons.set(kind, button);
        }
        group.add(flow);
        this.destinationRow = new Adw.ActionRow({
            title: 'Base folder in destination',
            subtitle: descriptorDisplay(this.job.destination, this.volumes) || 'Not selected',
        });
        const choose = new Gtk.Button({
            label: 'Choose',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        choose.connect('clicked', () => this._chooseDescriptor('Destination',
            this.job.destination, descriptor => this._setDestination(descriptor)));
        this.destinationRow.add_suffix(choose);
        group.add(this.destinationRow);
        this.accountsRow = new Adw.ActionRow({
            title: 'Cloud accounts',
            subtitle: 'Add, reconnect or delete accounts without leaving this wizard.',
        });
        const manage = new Gtk.Button({
            label: 'Manage',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        manage.connect('clicked', () => this._manageAccounts());
        this.accountsRow.add_suffix(manage);
        this.accountsGroup = new Adw.PreferencesGroup({title: 'Cloud accounts'});
        this.accountsGroup.add(this.accountsRow);
        page.add(group);
        page.add(this.accountsGroup);
        this._renderExistingDestinations();
        this._updateProviderSelection();
        this._updateAccountsHint();
        return page;
    }

    _usedDestinations() {
        const entries = new Map();
        for (const job of this.parentWindow.snapshot?.jobs || []) {
            if (job.id === this.job.id || job.draft)
                continue;
            const descriptor = job.destination;
            if (!descriptor || !(descriptor.path || descriptor.remote || descriptor.volumeUuid))
                continue;
            const key = descriptorKey(descriptor);
            if (!entries.has(key)) {
                entries.set(key, {
                    descriptor,
                    jobs: [],
                    types: new Set(),
                    layouts: new Set(),
                    current: false,
                });
            }
            entries.get(key).jobs.push(job.name || job.id);
            entries.get(key).types.add(job.type);
            entries.get(key).layouts.add(job.destinationLayout || 'saveMe');
        }
        const current = this.job.destination;
        if (current && (current.path || current.remote || current.volumeUuid)) {
            const key = descriptorKey(current);
            if (!entries.has(key)) {
                entries.set(key, {
                    descriptor: current,
                    jobs: [],
                    types: new Set(),
                    layouts: new Set(),
                    current: true,
                });
            } else {
                entries.get(key).current = true;
            }
        }
        return [...entries.values()];
    }

    _destinationCompatible(entry) {
        const layout = this.job.destinationLayout === 'direct' ? 'direct' : 'saveMe';
        if (layout === 'direct')
            return entry.jobs.length === 0;
        return [...entry.layouts].every(item => item !== 'direct');
    }

    _destinationJobsLabel(entry) {
        const typeNames = [...entry.types]
            .map(type => type === 'backup' ? 'Backup' : 'Sync')
            .join('/');
        const jobs = entry.jobs.length > 0 ? entry.jobs.join(', ') : 'this job';
        return `${entry.current ? 'This job · ' : ''}Used by ${jobs}` +
            (typeNames ? ` (${typeNames})` : '');
    }

    _destinationServiceLabel(descriptor) {
        if (descriptor?.kind === 'remote') {
            const remote = (this.parentWindow.snapshot?.remotes || [])
                .find(item => item.name === descriptor.remote);
            return `${remoteTypeLabel(remote?.type || 'cloud')} · ${descriptor.remote}`;
        }
        return 'Local folder';
    }

    _matchesCurrentDestination(descriptor) {
        const current = this.job.destination;
        if (!current || !(current.path || current.remote || current.volumeUuid))
            return false;
        return descriptorKey(current) === descriptorKey(descriptor);
    }

    _renderExistingDestinations() {
        for (const row of this.existingRows || [])
            this.existingGroup.remove(row);
        this.existingRows = [];
        this.destinations = this._usedDestinations();
        for (const entry of this.destinations) {
            const compatible = this._destinationCompatible(entry);
            const selected = this._destinationMode === 'existing' && compatible &&
                this._matchesCurrentDestination(entry.descriptor);
            const row = new Adw.ActionRow({
                title: this._destinationServiceLabel(entry.descriptor),
                subtitle: `${descriptorDisplay(entry.descriptor, this.volumes)} · ` +
                    this._destinationJobsLabel(entry),
            });
            row.add_prefix(new Gtk.Image({
                icon_name: entry.descriptor.kind === 'remote'
                    ? 'folder-remote-symbolic' : 'drive-harddisk-symbolic',
                pixel_size: 18,
            }));
            if (!compatible)
                row.add_css_class('saveme-destination-incompatible');
            if (selected) {
                row.add_suffix(new Gtk.Image({
                    icon_name: 'object-select-symbolic',
                    pixel_size: 18,
                    css_classes: ['success'],
                }));
            } else if (compatible) {
                const use = new Gtk.Button({
                    label: 'Use',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                use.connect('clicked', () => this._useExistingDestination(entry.descriptor));
                row.add_suffix(use);
            } else {
                row.add_suffix(new Gtk.Label({
                    label: 'Not shareable',
                    css_classes: ['dim-label'],
                }));
            }
            row.connect('activated', () => {
                if (compatible)
                    this._useExistingDestination(entry.descriptor);
            });
            this.existingGroup.add(row);
            this.existingRows.push(row);
        }
        if (this.destinations.length === 0) {
            const empty = new Adw.ActionRow({
                title: 'No destinations in use',
                subtitle: 'Create the first destination below.',
                sensitive: false,
            });
            this.existingGroup.add(empty);
            this.existingRows.push(empty);
        }
        const newSelected = this._destinationMode === 'new';
        const newRow = new Adw.ActionRow({
            title: 'Create new destination',
            subtitle: 'Choose a provider and a new base folder.',
        });
        newRow.add_prefix(new Gtk.Image({
            icon_name: 'list-add-symbolic',
            pixel_size: 18,
        }));
        if (newSelected) {
            newRow.add_suffix(new Gtk.Image({
                icon_name: 'object-select-symbolic',
                pixel_size: 18,
                css_classes: ['success'],
            }));
        } else {
            const create = new Gtk.Button({
                label: 'New',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat', 'suggested-action'],
            });
            create.connect('clicked', () => this._useNewDestination());
            newRow.add_suffix(create);
        }
        newRow.connect('activated', () => this._useNewDestination());
        this.existingGroup.add(newRow);
        this.existingRows.push(newRow);
        this.newDestinationGroup.visible = newSelected;
    }

    _useExistingDestination(descriptor) {
        this._destinationMode = 'existing';
        this._setDestination(JSON.parse(JSON.stringify(descriptor)));
        this._renderExistingDestinations();
    }

    _useNewDestination() {
        this._destinationMode = 'new';
        this._setDestination({kind: 'local', path: ''});
        this._renderExistingDestinations();
    }

    _buildSchedulePage() {
        const page = this._page();
        const group = new Adw.PreferencesGroup({
            title: 'Schedule',
            description: 'Choose when the job should run.',
        });
        this.triggerModes = TRIGGER_OPTIONS;
        this.triggerRow = new Adw.ComboRow({
            title: 'Mode',
            model: Gtk.StringList.new(TRIGGER_OPTIONS.map(item => item.label)),
            selected: 0,
        });
        this.triggerRow.connect('notify::selected', () => {
            if (this._updatingTrigger)
                return;
            this.triggerMode = this.triggerModes[this.triggerRow.selected]?.mode ||
                TRIGGER_MODES.MANUAL;
            this._updateTriggerRows();
        });
        group.add(this.triggerRow);

        this.intervalRow = new Adw.SpinRow({
            title: 'Every',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 10080,
                step_increment: 1,
                page_increment: 30,
                value: Number(this.job.trigger.intervalValue || 1),
            }),
        });
        this.intervalUnitRow = new Adw.ComboRow({
            title: 'Interval unit',
            model: Gtk.StringList.new(['minutes', 'hours', 'days']),
            selected: Math.max(0, INTERVAL_UNITS.indexOf(
                this.job.trigger.intervalUnit || 'hours')),
        });
        this.dayOfWeekRow = new Adw.ComboRow({
            title: 'Day of week',
            model: Gtk.StringList.new(WEEKDAYS),
            selected: Number(this.job.trigger.dayOfWeek ?? 1),
        });
        this.dayOfMonthRow = new Adw.SpinRow({
            title: 'Day of month',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 31,
                step_increment: 1,
                page_increment: 1,
                value: Number(this.job.trigger.dayOfMonth || 1),
            }),
        });
        this.timeRow = new Adw.EntryRow({
            title: 'Time (HH:MM)',
            text: this.job.trigger.time || '18:00',
        });
        this.idleRow = new Adw.SwitchRow({
            title: 'Only run when the computer is idle',
            subtitle: 'Wait for mouse, keyboard and screen activity to stop.',
            active: Boolean(this.job.trigger.idleOnly),
        });
        group.add(this.intervalRow);
        group.add(this.intervalUnitRow);
        group.add(this.dayOfWeekRow);
        group.add(this.dayOfMonthRow);
        group.add(this.timeRow);
        group.add(this.idleRow);
        page.add(group);

        this.backupGroup = new Adw.PreferencesGroup({title: 'Backup'});
        this.keepForeverRow = new Adw.SwitchRow({
            title: 'Keep versions forever',
            subtitle: 'Ignore the retention period and never remove old versions.',
            active: Boolean(this.job.backup.keepForever),
        });
        this.retentionRow = new Adw.SpinRow({
            title: 'Keep versions for (days)',
            subtitle: 'Disabled when versions are kept forever',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 3650,
                step_increment: 1,
                page_increment: 30,
                value: Math.max(1, Number(this.job.backup.retentionDays || 30)),
            }),
        });
        this.keepForeverRow.connect('notify::active', () => {
            this.retentionRow.sensitive = !this.keepForeverRow.active;
        });
        this.backupGroup.add(this.keepForeverRow);
        this.backupGroup.add(this.retentionRow);
        page.add(this.backupGroup);
        this._setTriggerMode(this.triggerModeForJob());
        return page;
    }

    triggerModeForJob() {
        if (this.typeRow.selected === 1 && this.job.trigger.mode === TRIGGER_MODES.REALTIME)
            return TRIGGER_MODES.INTERVAL;
        return this.job.trigger.mode || TRIGGER_MODES.REALTIME;
    }

    _setTriggerMode(mode) {
        this._syncTriggerOptions(mode);
        this._updateTriggerRows();
    }

    _syncTriggerOptions(preferred = null) {
        const backup = this.typeRow.selected === 1;
        const modes = backup
            ? TRIGGER_OPTIONS.filter(item => item.mode !== TRIGGER_MODES.REALTIME)
            : TRIGGER_OPTIONS;
        const current = preferred || this.triggerMode ||
            (backup ? TRIGGER_MODES.INTERVAL : this.job.trigger.mode);
        const selected = modes.findIndex(item => item.mode === current);
        this.triggerModes = modes;
        this._updatingTrigger = true;
        this.triggerRow.model = Gtk.StringList.new(modes.map(item => item.label));
        this.triggerRow.selected = Math.max(0, selected);
        this._updatingTrigger = false;
        this.triggerMode = modes[Math.max(0, selected)]?.mode || TRIGGER_MODES.MANUAL;
    }

    _updateTriggerRows() {
        if (!this.intervalUnitRow)
            return;
        this.intervalRow.visible = this.triggerMode === TRIGGER_MODES.INTERVAL;
        this.intervalUnitRow.visible = this.triggerMode === TRIGGER_MODES.INTERVAL;
        this.dayOfWeekRow.visible = this.triggerMode === TRIGGER_MODES.WEEKLY;
        this.dayOfMonthRow.visible = this.triggerMode === TRIGGER_MODES.MONTHLY;
        this.timeRow.visible = [TRIGGER_MODES.WEEKLY, TRIGGER_MODES.MONTHLY,
            TRIGGER_MODES.DUSK].includes(this.triggerMode);
        this.idleRow.visible = ![TRIGGER_MODES.REALTIME,
            TRIGGER_MODES.MANUAL].includes(this.triggerMode);
        if (this.backupGroup)
            this.backupGroup.visible = this.typeRow.selected === 1;
        if (this.retentionRow)
            this.retentionRow.sensitive = !this.keepForeverRow?.active;
    }

    _intervalMinutes() {
        const selected = Math.max(0, this.intervalUnitRow?.selected ?? 0);
        const unit = INTERVAL_UNITS[selected] || 'minutes';
        const factor = {minutes: 1, hours: 60, days: 1440}[unit] || 1;
        return Math.max(1, Math.round(Number(this.intervalRow?.value || 1) * factor));
    }

    _buildSafetyPage() {
        const page = this._page();
        const safety = new Adw.PreferencesGroup({
            title: 'Safety',
            description: 'The defaults are suitable for most jobs.',
        });
        this.maxDeleteRow = new Adw.SpinRow({
            title: 'Maximum deletion (%)',
            subtitle: 'Abort when a run would delete more than this percentage',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 100,
                step_increment: 1,
                page_increment: 10,
                value: Number(this.job.options.maxDeletePercent ?? 10),
            }),
        });
        this.maxDeleteMinimumRow = new Adw.SpinRow({
            title: 'Minimum deletion allowance (files)',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 100000,
                step_increment: 1,
                page_increment: 10,
                value: Number(this.job.options.maxDeleteMinimum ?? 10),
            }),
        });
        this.bandwidthRow = new Adw.EntryRow({
            title: 'Bandwidth limit (e.g. 10M)',
            text: this.job.options.bandwidthLimit || '',
        });
        this.notifyRow = new Adw.SwitchRow({
            title: 'Notify when the job finishes',
            subtitle: 'Show a desktop notification after a completed backup.',
            active: this.job.options.notifyOnComplete !== false,
        });
        safety.add(this.maxDeleteRow);
        safety.add(this.maxDeleteMinimumRow);
        safety.add(this.bandwidthRow);
        safety.add(this.notifyRow);
        page.add(safety);

        const advanced = new Adw.PreferencesGroup({title: 'Advanced'});
        this.advancedExpander = new Adw.ExpanderRow({
            title: 'Performance and metadata',
            subtitle: 'Transfers, checkers, metadata and symbolic links',
        });
        this.transfersRow = new Adw.SpinRow({
            title: 'Parallel transfers',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 64,
                step_increment: 1,
                page_increment: 4,
                value: Number(this.job.options.transfers || 4),
            }),
        });
        this.checkersRow = new Adw.SpinRow({
            title: 'Parallel checkers',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 64,
                step_increment: 1,
                page_increment: 4,
                value: Number(this.job.options.checkers || 8),
            }),
        });
        this.metadataRow = new Adw.SwitchRow({
            title: 'Preserve metadata',
            active: Boolean(this.job.options.preserveMetadata),
        });
        this.symlinkRow = new Adw.SwitchRow({
            title: 'Follow symbolic links',
            active: Boolean(this.job.options.followSymlinks),
        });
        this.advancedExpander.add_row(this.transfersRow);
        this.advancedExpander.add_row(this.checkersRow);
        this.advancedExpander.add_row(this.metadataRow);
        this.advancedExpander.add_row(this.symlinkRow);
        advanced.add(this.advancedExpander);
        page.add(advanced);
        return page;
    }

    _showStep(index) {
        this._step = Math.max(0, Math.min(STEP_TITLES.length - 1, index));
        const names = ['general', 'sources', 'destination', 'schedule', 'safety'];
        this.stack.set_visible_child_name(names[this._step]);
        const title = this.isDraft ? 'Continue job' : this.isNew ? 'New job' : 'Edit job';
        this.windowTitle.title = `${title} · ` +
            `${STEP_TITLES[this._step]} (${this._step + 1}/${STEP_TITLES.length})`;
        this.backButton.visible = this._step > 0;
        this.nextButton.visible = this._step < STEP_TITLES.length - 1;
        this.saveButton.visible = this._step === STEP_TITLES.length - 1;
        this.runButton.visible = this._step === STEP_TITLES.length - 1;
        this.cancelButton.label = this._step >= 1 && (this.isNew || this.isDraft)
            ? 'Close' : 'Cancel';
        if (this._ready)
            this._autosaveDraft(this._step);
    }

    _next() {
        if (this._validateStep(this._step))
            this._showStep(this._step + 1);
    }

    _validateStep(index) {
        if (index === 0 && !this.nameRow.text.trim()) {
            this._showError('Give the job a name.');
            return false;
        }
        if (index === 1 && !this.sources.some(source => source.path || source.volumeUuid)) {
            this._showError('Choose at least one source folder.');
            return false;
        }
        if (index === 2 && !this._destinationSelected()) {
            this._showError('Choose a destination.');
            return false;
        }
        if (index === 2) {
            const compatibility = this._destinationCompatibilityError();
            if (compatibility) {
                this._showError(compatibility);
                return false;
            }
        }
        if (index === 3) {
            if (this.triggerMode === TRIGGER_MODES.INTERVAL && this._intervalMinutes() < 1) {
                this._showError('The interval must be at least one minute.');
                return false;
            }
            if (this.triggerMode === TRIGGER_MODES.WEEKLY && this.dayOfWeekRow.selected < 0) {
                this._showError('Choose a day of the week.');
                return false;
            }
            if ([TRIGGER_MODES.WEEKLY, TRIGGER_MODES.MONTHLY, TRIGGER_MODES.DUSK]
                .includes(this.triggerMode) && !isValidTime(this.timeRow.text)) {
                this._showError('Use a time in the HH:MM format (for example 18:00).');
                return false;
            }
        }
        return true;
    }

    _showError(message) {
        const dialog = new Adw.AlertDialog({heading: 'Check this step', body: message});
        dialog.add_response('ok', 'OK');
        dialog.present(this);
    }

    _destinationSelected() {
        const destination = this.job.destination;
        return destination && (destination.path || destination.volumeUuid || destination.remote);
    }

    _destinationCompatibilityError() {
        if (!this._destinationSelected())
            return null;
        const key = descriptorKey(this.job.destination);
        const others = (this.parentWindow.snapshot?.jobs || []).filter(job =>
            job.id !== this.job.id && !job.draft &&
            descriptorKey(job.destination) === key);
        if (others.length === 0)
            return null;
        const layout = this.job.destinationLayout === 'direct' ? 'direct' : 'saveMe';
        if (layout === 'saveMe' &&
            others.every(job => job.destinationLayout !== 'direct'))
            return null;
        if (layout === 'saveMe') {
            return 'This base is used by a legacy direct sync job and cannot be ' +
                'shared. Choose another destination.';
        }
        return 'Direct sync destinations cannot be shared with another job. ' +
            'Choose another destination or create a new SaveMe base.';
    }

    _addChooseButton(row, callback) {
        const button = new Gtk.Button({
            label: 'Choose',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        button.connect('clicked', callback);
        row.add_suffix(button);
    }

    _renderSources() {
        for (const row of this.sourceRows)
            this.sourcesGroup.remove(row);
        if (this.addSourceAttached) {
            this.sourcesGroup.remove(this.addSourceRow);
            this.addSourceAttached = false;
        }
        this.sourceRows = [];
        const backup = this.typeRow?.selected === 1;
        for (const [index, source] of this.sources.entries()) {
            const row = new Adw.ActionRow({
                title: `Source ${index + 1}`,
                subtitle: descriptorDisplay(source, this.volumes) || 'Not selected',
            });
            this._addChooseButton(row, () => {
                this._chooseSourceDescriptor(index, this.sources[index],
                    descriptor => {
                        this.sources[index] = descriptor;
                        this._renderSources();
                    });
            });
            if (backup && this.sources.length > 1) {
                const remove = new Gtk.Button({
                    icon_name: 'list-remove-symbolic',
                    tooltip_text: `Remove source ${index + 1}`,
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat', 'destructive-action'],
                });
                remove.connect('clicked', () => {
                    this.sources.splice(index, 1);
                    if (this.sources.length === 0)
                        this.sources.push({kind: 'local', path: ''});
                    this._renderSources();
                });
                row.add_suffix(remove);
            }
            this.sourcesGroup.add(row);
            this.sourceRows.push(row);
        }
        if (backup) {
            this.sourcesGroup.add(this.addSourceRow);
            this.addSourceAttached = true;
        }
    }

    _addSource() {
        if (this.typeRow.selected !== 1) {
            this.parentWindow.toast('Multiple sources are only available for backups.');
            return;
        }
        this.sources.push({kind: 'local', path: ''});
        this._renderSources();
    }

    _updateVisibility() {
        const type = this.typeRow.selected === 1 ? JOB_TYPES.BACKUP : JOB_TYPES.SYNC;
        if (type !== JOB_TYPES.BACKUP && this.sources.length > 1)
            this.sources = [this.sources[0]];
        if (this.sourcesGroup)
            this._renderSources();
        if (this.existingGroup)
            this._renderExistingDestinations();
        if (!this.triggerRow)
            return;
        this._syncTriggerOptions(this.triggerMode || this.job.trigger.mode);
        this._updateTriggerRows();
    }

    _setDestination(descriptor) {
        this.job.destination = descriptor;
        this.destinationRow.set_subtitle(
            descriptorDisplay(descriptor, this.volumes) || 'Not selected');
        this._updateProviderSelection();
        if (this.existingGroup)
            this._renderExistingDestinations();
    }

    _updateProviderSelection() {
        const destination = this.job.destination;
        for (const [kind, button] of this.providerButtons || []) {
            button.remove_css_class('suggested-action');
            const selected = kind === 'local'
                ? destination?.kind === 'local'
                : destination?.kind === 'remote' &&
                    this._providerForRemote(destination.remote) === kind;
            if (selected)
                button.add_css_class('suggested-action');
        }
    }

    _providerForRemote(name) {
        const remote = (this.parentWindow.snapshot?.remotes || [])
            .find(item => item.name === name);
        return remote?.type || null;
    }

    _pickProvider(type) {
        const remotes = (this.parentWindow.snapshot?.remotes || [])
            .filter(remote => remote.type === type);
        if (remotes.length === 0) {
            new AccountDialog(this.parentWindow, null, {
                provider: type,
                transientFor: this,
                onDone: () => {
                    this._updateAccountsHint();
                    this._pickProvider(type);
                },
            }).present();
            return;
        }
        const current = this.job.destination?.kind === 'remote' &&
            this._providerForRemote(this.job.destination.remote) === type
            ? this.job.destination
            : null;
        new RemoteBrowserDialog(this.parentWindow, {
            mode: 'pick',
            remoteType: type,
            remote: current?.remote || remotes[0].name,
            path: current?.path || '',
            transientFor: this,
            onSelect: descriptor => this._setDestination(descriptor),
        }).present();
    }

    _manageAccounts() {
        new AccountsDialog(this.parentWindow, {
            transientFor: this,
            onUse: remote => this._browseRemote(remote),
            onDeleted: name => this._forgetRemote(name),
            onDone: () => {
                this._updateProviderSelection();
                this._updateAccountsHint();
            },
        }).present();
    }

    _browseRemote(remote) {
        const current = this.job.destination?.kind === 'remote' &&
            this.job.destination.remote === remote.name
            ? this.job.destination
            : null;
        new RemoteBrowserDialog(this.parentWindow, {
            mode: 'pick',
            remoteType: remote.type,
            remote: remote.name,
            path: current?.path || '',
            transientFor: this,
            onSelect: descriptor => this._setDestination(descriptor),
        }).present();
    }

    _forgetRemote(name) {
        if (this.job.destination?.kind === 'remote' &&
            this.job.destination.remote === name)
            this._setDestination({kind: 'local', path: ''});
        let changed = false;
        this.sources = this.sources.map(source => {
            if (source?.kind === 'remote' && source.remote === name) {
                changed = true;
                return {kind: 'local', path: ''};
            }
            return source;
        });
        if (changed)
            this._renderSources();
        this._updateProviderSelection();
        this._updateAccountsHint();
    }

    _updateAccountsHint() {
        if (!this.accountsRow)
            return;
        const remotes = this.parentWindow.snapshot?.remotes || [];
        this.accountsRow.set_subtitle(remotes.length === 0
            ? 'No accounts configured. Add one to use a cloud destination.'
            : `${remotes.length} account${remotes.length === 1 ? '' : 's'} configured. ` +
                'Add, reconnect or delete accounts here.');
    }

    _chooseSourceDescriptor(index, current, callback) {
        const dialog = new Adw.AlertDialog({
            heading: `Source ${index + 1}`,
            body: `Current: ${descriptorDisplay(current, this.volumes) || 'Not selected'}`,
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('drive', 'Google Drive');
        dialog.add_response('onedrive', 'OneDrive');
        dialog.add_response('dropbox', 'Dropbox');
        dialog.add_response('local', 'Local folder');
        dialog.set_response_appearance('local', Adw.ResponseAppearance.SUGGESTED);
        dialog.connect('response', (_dialog, response) => {
            if (response === 'local') {
                this._pickLocalFolder(callback);
                return;
            }
            if (['dropbox', 'onedrive', 'drive'].includes(response))
                this._pickSourceProvider(response, callback, current);
        });
        dialog.present(this);
    }

    _pickSourceProvider(type, callback, currentDescriptor = null) {
        const remotes = (this.parentWindow.snapshot?.remotes || [])
            .filter(remote => remote.type === type);
        if (remotes.length === 0) {
            new AccountDialog(this.parentWindow, null, {
                provider: type,
                transientFor: this,
                onDone: () => {
                    this._updateAccountsHint();
                    this._pickSourceProvider(type, callback, currentDescriptor);
                },
            }).present();
            return;
        }
        const current = currentDescriptor?.kind === 'remote' &&
            this._providerForRemote(currentDescriptor.remote) === type
            ? currentDescriptor
            : null;
        new RemoteBrowserDialog(this.parentWindow, {
            mode: 'pick',
            remoteType: type,
            remote: current?.remote || remotes[0].name,
            path: current?.path || '',
            transientFor: this,
            onSelect: descriptor => callback(descriptor),
        }).present();
    }

    _chooseDescriptor(title, current, callback) {
        const dialog = new Adw.AlertDialog({
            heading: title,
            body: `Current: ${descriptorDisplay(current, this.volumes) || 'Not selected'}`,
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('local', 'Local folder');
        dialog.add_response('remote', 'Cloud remote');
        dialog.set_response_appearance('local', Adw.ResponseAppearance.SUGGESTED);
        dialog.connect('response', (_dialog, response) => {
            if (response === 'local')
                this._pickLocalFolder(callback);
            else if (response === 'remote')
                this._pickRemote(callback, current);
        });
        dialog.present(this);
    }

    _pickLocalFolder(callback) {
        const dialog = new Gtk.FileDialog({title: 'Choose folder', modal: true});
        dialog.select_folder(this, null, (source, result) => {
            try {
                const file = source.select_folder_finish(result);
                const path = file.get_path();
                if (path)
                    callback(this.volumes.makeDescriptor(path));
            } catch (_) {
                // Dialog dismissed.
            }
        });
    }

    _pickRemote(callback, currentDescriptor = null) {
        const current = currentDescriptor?.kind === 'remote' ? currentDescriptor : null;
        new RemoteBrowserDialog(this.parentWindow, {
            mode: 'pick',
            remote: current?.remote || null,
            path: current?.path || '',
            transientFor: this,
            onSelect: descriptor => callback(descriptor),
        }).present();
    }

    _collectJob() {
        const type = this.typeRow.selected === 1 ? JOB_TYPES.BACKUP : JOB_TYPES.SYNC;
        return normalizeJob({
            ...this.job,
            name: this.nameRow.text.trim(),
            type,
            source: this.sources[0],
            sources: this.sources,
            destination: this.job.destination,
            trigger: {
                mode: this.triggerMode,
                intervalMinutes: this._intervalMinutes(),
                intervalValue: Number(this.intervalRow.value),
                intervalUnit: INTERVAL_UNITS[this.intervalUnitRow.selected] || 'hours',
                dayOfWeek: this.dayOfWeekRow.selected,
                dayOfMonth: Number(this.dayOfMonthRow.value),
                time: this.timeRow.text.trim() || '18:00',
                idleOnly: this.idleRow.active,
            },
            filters: {
                exclude: String(this.filtersRow.text || '')
                    .split(',')
                    .map(value => value.trim())
                    .filter(Boolean),
            },
            options: {
                ...this.job.options,
                maxDeletePercent: Number(this.maxDeleteRow.value),
                maxDeleteMinimum: Number(this.maxDeleteMinimumRow.value),
                transfers: Number(this.transfersRow.value),
                checkers: Number(this.checkersRow.value),
                bandwidthLimit: this.bandwidthRow.text.trim(),
                preserveMetadata: this.metadataRow.active,
                followSymlinks: this.symlinkRow.active,
                notifyOnComplete: this.notifyRow.active,
            },
            backup: {
                retentionDays: this.keepForeverRow.active
                    ? 0 : Number(this.retentionRow.value),
                keepForever: this.keepForeverRow.active,
            },
            draft: Boolean(this.job.draft),
            draftStep: Number(this.job.draftStep || 0),
            enabled: this.job.enabled !== false,
        });
    }

    _autosaveDraft(step) {
        if (!this._ready || this._saved || this._saving)
            return;
        if (!this.isNew && !this.job.draft)
            return;
        if (step < 1)
            return;
        this._draftQueuedStep = Math.max(this._draftQueuedStep || 0, step);
        if (this._draftPromise)
            return;
        const saveQueued = () => {
            const draftStep = this._draftQueuedStep;
            this._draftQueuedStep = 0;
            if (!draftStep) {
                this._draftPromise = null;
                return;
            }
            const job = this._collectJob();
            job.draft = true;
            job.draftStep = draftStep;
            job.enabled = false;
            this._draftPromise = this.client.saveJob(job)
                .then(saved => {
                    this.job = normalizeJob(saved);
                    this.job.draft = true;
                    this.isNew = true;
                    this.isDraft = true;
                    this.parentWindow.refresh();
                    if (this._closing) {
                        this._closing = false;
                        this.parentWindow.toast('Draft saved. Continue later from Jobs.');
                    }
                })
                .catch(e => this.parentWindow.toast(`Cannot save draft: ${e.message}`))
                .finally(() => {
                    this._draftPromise = null;
                    saveQueued();
                });
        };
        saveQueued();
    }

    async _save(run) {
        if (this._saving)
            return;
        for (let step = 0; step < 4; step++) {
            if (!this._validateStep(step)) {
                this._showStep(step);
                return;
            }
        }
        // Do not let a delayed draft autosave overwrite the final job.
        this._draftQueuedStep = 0;
        if (this._draftPromise) {
            try {
                await this._draftPromise;
            } catch (_) {
                // The final save below reports any remaining problem.
            }
        }
        const job = this._collectJob();
        job.draft = false;
        job.draftStep = 0;
        job.enabled = true;
        delete job.state;
        const remotes = (this.parentWindow.snapshot?.remotes || []).map(remote => remote.name);
        const errors = validateJob(job, {remotes});
        if (errors.length > 0) {
            this._showError(errors.join('\n'));
            return;
        }
        this._setSaving(true);
        try {
            const saved = await this.client.saveJob(job);
            this._saved = true;
            if (run)
                await this.client.runJob(saved.id, false, false);
            this.parentWindow.toast(run
                ? 'Job saved and run started.'
                : 'Job saved.');
            this.parentWindow.refresh();
            this.close();
        } catch (e) {
            // A slow cloud destination may finish after the client gives up.
            if (await this._saveFinishedInDaemon(run))
                return;
            this._showError(this._saveErrorMessage(e));
        } finally {
            this._setSaving(false);
        }
    }

    _setSaving(saving) {
        this._saving = saving;
        for (const button of [this.saveButton, this.runButton,
            this.nextButton, this.backButton]) {
            if (button)
                button.sensitive = !saving;
        }
        if (this.runButton)
            this.runButton.label = saving ? 'Saving…' : 'Save & Run';
    }

    _saveErrorMessage(error) {
        const message = cleanError(error.message);
        if (/timeout|timed out|tempo limite|tempo esgotado/i.test(message)) {
            return 'The operation took longer than expected. The job may still be ' +
                'finishing; check the Jobs list in a moment before trying again.';
        }
        return message;
    }

    async _saveFinishedInDaemon(run) {
        if (!this.isNew && !this.isDraft)
            return false;
        try {
            await this.parentWindow.refresh();
        } catch (_) {
            return false;
        }
        const saved = (this.parentWindow.snapshot?.jobs || [])
            .find(job => job.id === this.job.id);
        if (!saved || saved.draft)
            return false;
        this._saved = true;
        if (run) {
            try {
                await this.client.runJob(saved.id, false, false);
            } catch (e) {
                if (!/already running/i.test(e.message || ''))
                    this.parentWindow.toast(`Job saved, but the run did not start: ${e.message}`);
            }
        }
        this.parentWindow.toast(run ? 'Job saved and run started.' : 'Job saved.');
        this.parentWindow.refresh();
        this.close();
        return true;
    }
});
