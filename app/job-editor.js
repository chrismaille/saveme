import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {VolumeResolver} from '../src/volumes.js';
import {AccountDialog} from './account-dialog.js';
import {AccountsDialog} from './accounts-dialog.js';
import {RemoteBrowserDialog} from './remote-browser.js';
import {SyncSelectionDialog} from './sync-selection-dialog.js';
import {
    JOB_TYPES,
    TRIGGER_MODES,
    defaultJob,
    descriptorDisplay,
    descriptorKey,
    localPathFor,
    normalizeJob,
    validateJob,
} from '../src/jobs.js';
import {INTERVAL_UNITS, WEEKDAYS, isValidTime, triggerLabel} from '../src/domain/schedule.js';
import {cleanError, remoteTypeLabel} from './presentation/format.js';
import {t} from '../src/i18n.js';
import {JobSaveDialog} from './job-save-dialog.js';

const MODULE_DIR = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const ASSETS_DIR = GLib.build_filenamev([MODULE_DIR, '..', 'assets']);
const SOURCE_PROVIDERS = [
    {type: 'local', label: 'Local folder', icon: 'drive-harddisk-symbolic'},
    {type: 'drive', label: 'Google Drive', logo: 'google-drive.png'},
    {type: 'onedrive', label: 'Microsoft OneDrive', logo: 'onedrive.png'},
    {type: 'dropbox', label: 'Dropbox', logo: 'dropbox.png'},
    {type: 'nextcloud', label: 'Nextcloud', logo: 'nextcloud.png'},
    {type: 's3', label: 'S3 compatible', logo: 's3.png'},
    {type: 'pcloud', label: 'pCloud', logo: 'pcloud.png'},
];

const TRIGGER_OPTIONS = [
    {mode: TRIGGER_MODES.REALTIME, label: t('Real-time')},
    {mode: TRIGGER_MODES.INTERVAL, label: t('Interval')},
    {mode: TRIGGER_MODES.WEEKLY, label: t('Weekly')},
    {mode: TRIGGER_MODES.MONTHLY, label: t('Monthly')},
    {mode: TRIGGER_MODES.STARTUP, label: t('At computer startup')},
    {mode: TRIGGER_MODES.DUSK, label: t('At dusk')},
    {mode: TRIGGER_MODES.MANUAL, label: t('Manual')},
];
const STEP_TITLES = [
    t('Type'), t('Name'), t('Source'), t('Content'), t('Filters'),
    t('Destination'), t('New destination'), t('Schedule'), t('Safety'), t('Review'),
];

export const JobEditor = GObject.registerClass({
    GTypeName: 'SaveMeJobEditor',
}, class JobEditor extends Adw.Window {
    constructor(parentWindow, job = null) {
        super({
            transient_for: parentWindow,
            modal: true,
            title: job?.draft ? t('Continue job') : job ? t('Edit job') : t('New job'),
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
        this.includes = [...(this.job.filters.include || [])];
        // The job type is fixed after creation. Editing starts at the name
        // step and cannot navigate back to the type chooser.
        this._firstStep = this.isNew ? 0 : 1;
        this._step = this.job.draft
            ? this.job.draftStep
            : this._firstStep;
        this._build();
    }

    _build() {
        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        this.windowTitle = new Adw.WindowTitle({title: this.title});
        header.set_title_widget(this.windowTitle);

        const cancel = new Gtk.Button({label: t('Cancel')});
        this.cancelButton = cancel;
        cancel.connect('clicked', () => this.close());
        header.pack_start(cancel);
        this.backButton = new Gtk.Button({
            icon_name: 'go-previous-symbolic',
            tooltip_text: t('Back'),
            css_classes: ['flat'],
        });
        this.backButton.connect('clicked', () => this._showStep(this._step - 1));
        header.pack_start(this.backButton);

        this.nextButton = new Gtk.Button({
            label: t('Next'),
            css_classes: ['suggested-action'],
        });
        this.nextButton.connect('clicked', () => this._next());
        header.pack_end(this.nextButton);
        this.saveButton = new Gtk.Button({label: t('Save')});
        this.saveButton.connect('clicked', () => this._save(false));
        header.pack_end(this.saveButton);
        this.runButton = new Gtk.Button({
            label: t('Save & Run'),
            css_classes: ['suggested-action'],
        });
        this.runButton.connect('clicked', () => this._save(true));
        header.pack_end(this.runButton);
        toolbar.add_top_bar(header);

        this.stack = new Adw.ViewStack();
        this.stack.add_titled(this._buildTypePage(), 'type', STEP_TITLES[0]);
        this.stack.add_titled(this._buildNamePage(), 'name', STEP_TITLES[1]);
        this.stack.add_titled(this._buildSourcePage(), 'source', STEP_TITLES[2]);
        this.stack.add_titled(this._buildContentPage(), 'content', STEP_TITLES[3]);
        this.stack.add_titled(this._buildFiltersPage(), 'filters', STEP_TITLES[4]);
        this.stack.add_titled(this._buildDestinationPage(), 'destination', STEP_TITLES[5]);
        this.stack.add_titled(this._buildNewDestinationPage(), 'newDestination', STEP_TITLES[6]);
        this.stack.add_titled(this._buildSchedulePage(), 'schedule', STEP_TITLES[7]);
        this.stack.add_titled(this._buildSafetyPage(), 'safety', STEP_TITLES[8]);
        this.stack.add_titled(this._buildReviewPage(), 'review', STEP_TITLES[9]);
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

    _buildTypePage() {
        const page = this._page();
        const group = new Adw.PreferencesGroup({
            title: t('Job type'),
            description: t('Choose how SaveMe should treat this folder.'),
        });
        this.typeRow = new Adw.ComboRow({
            title: t('Type'),
            model: Gtk.StringList.new([t('Sync'), t('Backup')]),
            selected: this.job.type === JOB_TYPES.BACKUP ? 1 : 0,
        });
        this.typeRow.connect('notify::selected', () => this._updateVisibility());
        const cards = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            homogeneous: true,
            margin_top: 8,
            margin_bottom: 8,
        });
        this.typeButtons = new Map();
        const addCard = (type, title, description, icon) => {
            const content = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 8,
                margin_top: 16,
                margin_bottom: 16,
                margin_start: 16,
                margin_end: 16,
                halign: Gtk.Align.CENTER,
            });
            content.append(new Gtk.Image({
                icon_name: icon,
                pixel_size: 48,
                halign: Gtk.Align.CENTER,
            }));
            content.append(new Gtk.Label({
                label: title,
                xalign: 0.5,
                justify: Gtk.Justification.CENTER,
                css_classes: ['title-3'],
            }));
            const detail = new Gtk.Label({
                label: description,
                xalign: 0.5,
                justify: Gtk.Justification.CENTER,
                wrap: true,
                css_classes: ['dim-label'],
            });
            content.append(detail);
            const button = new Gtk.Button({
                height_request: 210,
                hexpand: true,
                css_classes: ['card'],
                child: content,
            });
            button.connect('clicked', () => {
                const selected = type === JOB_TYPES.BACKUP ? 1 : 0;
                if (!this.isNew && this.typeRow.selected !== selected) {
                    this.parentWindow.toast(
                        t('The job type cannot be changed after creation.'));
                    return;
                }
                this.typeRow.selected = selected;
                this._updateVisibility();
                this._showStep(1);
            });
            cards.append(button);
            this.typeButtons.set(type, button);
        };
        addCard(JOB_TYPES.SYNC, t('Sync'),
            t('Mirror the selected content. Changes and deletions are reflected ' +
                'in the destination.'), 'emblem-synchronizing-symbolic');
        addCard(JOB_TYPES.BACKUP, t('Backup'),
            t('Keep previous versions of changed or deleted files according to ' +
                'the retention policy.'), 'document-save-symbolic');
        this._updateTypeSelection();
        this.typeRow.connect('notify::selected', () => this._updateTypeSelection());
        group.add(cards);

        page.add(group);
        return page;
    }

    _updateTypeSelection() {
        if (!this.typeButtons)
            return;
        const selected = this.typeRow.selected === 1
            ? JOB_TYPES.BACKUP : JOB_TYPES.SYNC;
        for (const [type, button] of this.typeButtons) {
            if (type === selected)
                button.add_css_class('suggested-action');
            else
                button.remove_css_class('suggested-action');
        }
    }

    _buildNamePage() {
        const page = this._page();
        const group = new Adw.PreferencesGroup({
            title: t('Name'),
            description: t('Give this job a name you will recognize later.'),
        });
        this.nameRow = new Adw.EntryRow({
            title: t('Name'),
            text: this.job.name || '',
        });
        group.add(this.nameRow);
        page.add(group);
        return page;
    }

    _buildSourcePage() {
        const page = this._page();
        this.sourcesGroup = new Adw.PreferencesGroup({
            title: t('Source'),
            description: t('Choose the folder where the files to be saved are.'),
        });
        const flow = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE,
            max_children_per_line: 3,
            column_spacing: 10,
            row_spacing: 10,
            homogeneous: true,
            margin_top: 8,
            margin_bottom: 8,
        });
        this.sourceProviderButtons = new Map();
        for (const provider of SOURCE_PROVIDERS) {
            const content = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 8,
                margin_top: 12,
                margin_bottom: 12,
            });
            if (provider.logo) {
                const image = Gtk.Image.new_from_file(
                    GLib.build_filenamev([ASSETS_DIR, provider.logo]));
                image.set_pixel_size(48);
                content.append(image);
            } else {
                content.append(new Gtk.Image({
                    icon_name: provider.icon,
                    pixel_size: 48,
                }));
            }
            content.append(new Gtk.Label({
                label: t(provider.label),
                xalign: 0.5,
                justify: Gtk.Justification.CENTER,
            }));
            const button = new Gtk.Button({
                height_request: 120,
                hexpand: true,
                css_classes: ['card'],
                child: content,
            });
            button.connect('clicked', () => this._chooseSourceProvider(provider.type));
            flow.append(button);
            this.sourceProviderButtons.set(provider.type, button);
        }
        this.sourcesGroup.add(flow);
        this.sourceRow = new Adw.ActionRow({
            title: t('Selected source'),
            subtitle: t('Not selected'),
        });
        this.sourcesGroup.add(this.sourceRow);
        this.sourceRows = [this.sourceRow];
        this._renderSources();
        page.add(this.sourcesGroup);
        return page;
    }

    _chooseSourceProvider(type) {
        if (type === 'local') {
            this._pickLocalFolder(descriptor => this._setSource(descriptor));
            return;
        }
        this._pickSourceProvider(type, descriptor => this._setSource(descriptor),
            this.sources[0]);
    }

    _setSource(descriptor) {
        const previous = descriptorKey(this.sources[0]);
        this.sources[0] = descriptor;
        if (descriptorKey(descriptor) !== previous) {
            this.includes = [];
            this._updateContentSummary();
        }
        this._renderSources();
        if (localPathFor(descriptor, this.volumes)) {
            this._showStep(3);
            this._selectSyncContent();
        }
    }

    _buildContentPage() {
        const page = this._page();
        this.contentGroup = new Adw.PreferencesGroup({
            title: t('Content'),
            description: t('Choose root folders/files to include. Selected folders ' +
                'include their descendants.'),
        });
        this.contentRow = new Adw.ActionRow({
            title: t('Content'),
            subtitle: t('All source content'),
        });
        this.contentButton = new Gtk.Button({
            label: t('Select'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        this.contentButton.connect('clicked', () => this._selectSyncContent());
        this.contentRow.add_suffix(this.contentButton);
        this.contentGroup.add(this.contentRow);
        page.add(this.contentGroup);
        this._updateContentSummary();
        return page;
    }

    _buildFiltersPage() {
        const page = this._page();
        const filters = new Adw.PreferencesGroup({
            title: t('Filters'),
            description: t('Exclude patterns are applied after the content selection.'),
        });
        this.filtersRow = new Adw.EntryRow({
            title: t('Exclude patterns (comma-separated)'),
            text: (this.job.filters.exclude || []).join(', '),
        });
        filters.add(this.filtersRow);
        page.add(filters);
        return page;
    }

    _buildDestinationPage() {
        const page = this._page();
        this.existingGroup = new Adw.PreferencesGroup({
            title: t('SaveMe folders'),
            description: t('Choose the SaveMe folder where data will be saved, or ' +
                'create a SaveMe folder in a new destination.'),
        });
        this.existingRows = [];
        this.destinations = this._usedDestinations();
        this._destinationMode = this.destinations.length > 0 ? 'existing' : 'new';
        page.add(this.existingGroup);

        this.accountsRow = new Adw.ActionRow({
            title: t('Cloud accounts'),
            subtitle: t('Add, reconnect or delete accounts without leaving this wizard.'),
        });
        const manage = new Gtk.Button({
            label: t('Manage'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        manage.connect('clicked', () => this._manageAccounts());
        this.accountsRow.add_suffix(manage);
        this.accountsGroup = new Adw.PreferencesGroup({title: t('Cloud accounts')});
        this.accountsGroup.add(this.accountsRow);
        page.add(this.accountsGroup);
        this._renderExistingDestinations();
        this._updateAccountsHint();
        return page;
    }

    _buildNewDestinationPage() {
        const page = this._page();
        const group = new Adw.PreferencesGroup({
            title: t('New destination'),
            description: t('Choose the service and the base folder. SaveMe creates its own ' +
                'job folder inside that base; several jobs can share the same base.'),
        });
        this.providerButtons = new Map();
        const providers = [
            {kind: 'local', label: t('Local folder'), icon: 'drive-harddisk-symbolic'},
            {kind: 'drive', label: 'Google Drive', logo: 'google-drive.png'},
            {kind: 'onedrive', label: 'Microsoft OneDrive', logo: 'onedrive.png'},
            {kind: 'dropbox', label: 'Dropbox', logo: 'dropbox.png'},
            {kind: 'nextcloud', label: 'Nextcloud', logo: 'nextcloud.png'},
            {kind: 's3', label: 'S3 compatible', logo: 's3.png'},
            {kind: 'pcloud', label: 'pCloud', logo: 'pcloud.png'},
        ];
        const flow = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE,
            max_children_per_line: 3,
            column_spacing: 10,
            row_spacing: 10,
            homogeneous: true,
            margin_top: 8,
            margin_bottom: 8,
        });
        for (const provider of providers) {
            const content = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 8,
                margin_top: 12,
                margin_bottom: 12,
            });
            if (provider.logo) {
                const image = Gtk.Image.new_from_file(
                    GLib.build_filenamev([ASSETS_DIR, provider.logo]));
                image.set_pixel_size(48);
                content.append(image);
            } else {
                content.append(new Gtk.Image({
                    icon_name: provider.icon,
                    pixel_size: 48,
                }));
            }
            content.append(new Gtk.Label({
                label: provider.label,
                xalign: 0.5,
                justify: Gtk.Justification.CENTER,
            }));
            const button = new Gtk.Button({
                height_request: 120,
                hexpand: true,
                css_classes: ['card'],
                child: content,
            });
            button.connect('clicked', () => {
                if (provider.kind === 'local')
                    this._pickLocalFolder(descriptor => this._setDestination(descriptor));
                else
                    this._pickProvider(provider.kind);
            });
            flow.append(button);
            this.providerButtons.set(provider.kind, button);
        }
        group.add(flow);
        this.destinationRow = new Adw.ActionRow({
            title: t('Base folder in destination'),
            subtitle: descriptorDisplay(this.job.destination, this.volumes) ||
                t('Not selected'),
        });
        group.add(this.destinationRow);
        page.add(group);
        this._updateProviderSelection();
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
            .map(type => type === 'backup' ? t('Backup') : t('Sync'))
            .join('/');
        const jobs = entry.jobs.length > 0 ? entry.jobs.join(', ') : t('this job');
        return `${entry.current ? `${t('This job')} · ` : ''}${t('Used by {jobs}', {jobs})}` +
            (typeNames ? ` (${typeNames})` : '');
    }

    _destinationServiceLabel(descriptor) {
        if (descriptor?.kind === 'remote') {
            const remote = (this.parentWindow.snapshot?.remotes || [])
                .find(item => item.name === descriptor.remote);
            return `${remoteTypeLabel(remote?.type || 'cloud')} · ${descriptor.remote}`;
        }
        return t('Local folder');
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
                    label: t('Use'),
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                use.connect('clicked', () => this._useExistingDestination(entry.descriptor));
                row.add_suffix(use);
            } else {
                row.add_suffix(new Gtk.Label({
                    label: t('Not shareable'),
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
                title: t('No SaveMe folders yet'),
                subtitle: t('Create the first SaveMe folder below.'),
                sensitive: false,
            });
            this.existingGroup.add(empty);
            this.existingRows.push(empty);
        }
        const newRow = new Adw.ActionRow({
            title: t('Create new SaveMe folder'),
            subtitle: t('Choose a service and a new base folder.'),
        });
        newRow.add_prefix(new Gtk.Image({
            icon_name: 'list-add-symbolic',
            pixel_size: 18,
        }));
        const create = new Gtk.Button({
            label: t('Create'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat', 'suggested-action'],
        });
        create.connect('clicked', () => {
            this._destinationMode = 'new';
            this._showStep(6);
        });
        newRow.add_suffix(create);
        newRow.connect('activated', () => {
            this._destinationMode = 'new';
            this._showStep(6);
        });
        this.existingGroup.add(newRow);
        this.existingRows.push(newRow);
    }

    _useExistingDestination(descriptor) {
        this._destinationMode = 'existing';
        this._setDestination(JSON.parse(JSON.stringify(descriptor)));
        this._renderExistingDestinations();
    }

    _useNewDestination() {
        this._destinationMode = 'new';
        this._setDestination({kind: 'local', path: ''});
        this._showStep(6);
    }

    _buildSchedulePage() {
        const page = this._page();
        const group = new Adw.PreferencesGroup({
            title: t('Schedule'),
            description: t('Choose when the job should run.'),
        });
        this.triggerModes = TRIGGER_OPTIONS;
        this.triggerRow = new Adw.ComboRow({
            title: t('Mode'),
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
            title: t('Every'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 10080,
                step_increment: 1,
                page_increment: 30,
                value: Number(this.job.trigger.intervalValue || 1),
            }),
        });
        this.intervalUnitRow = new Adw.ComboRow({
            title: t('Interval unit'),
            model: Gtk.StringList.new([t('minutes'), t('hours'), t('days')]),
            selected: Math.max(0, INTERVAL_UNITS.indexOf(
                this.job.trigger.intervalUnit || 'hours')),
        });
        this.dayOfWeekRow = new Adw.ComboRow({
            title: t('Day of week'),
            model: Gtk.StringList.new(WEEKDAYS),
            selected: Number(this.job.trigger.dayOfWeek ?? 1),
        });
        this.dayOfMonthRow = new Adw.SpinRow({
            title: t('Day of month'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 31,
                step_increment: 1,
                page_increment: 1,
                value: Number(this.job.trigger.dayOfMonth || 1),
            }),
        });
        this.timeRow = new Adw.EntryRow({
            title: t('Time (HH:MM)'),
            text: this.job.trigger.time || '18:00',
        });
        this.duskRow = new Adw.ActionRow({
            title: t('At dusk'),
            subtitle: t('Calculated automatically from the GNOME night light schedule.'),
        });
        this.idleRow = new Adw.SwitchRow({
            title: t('Only run when the computer is idle'),
            subtitle: t('Wait for mouse, keyboard and screen activity to stop.'),
            active: Boolean(this.job.trigger.idleOnly),
        });
        group.add(this.intervalRow);
        group.add(this.intervalUnitRow);
        group.add(this.dayOfWeekRow);
        group.add(this.dayOfMonthRow);
        group.add(this.timeRow);
        group.add(this.duskRow);
        group.add(this.idleRow);
        page.add(group);

        this.backupGroup = new Adw.PreferencesGroup({title: t('Backup')});
        this.keepForeverRow = new Adw.SwitchRow({
            title: t('Keep versions forever'),
            subtitle: t('Ignore the retention period and never remove old versions.'),
            active: Boolean(this.job.backup.keepForever),
        });
        this.retentionRow = new Adw.SpinRow({
            title: t('Keep versions for (days)'),
            subtitle: t('Disabled when versions are kept forever'),
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
        this.timeRow.visible = [TRIGGER_MODES.WEEKLY, TRIGGER_MODES.MONTHLY]
            .includes(this.triggerMode);
        this.duskRow.visible = this.triggerMode === TRIGGER_MODES.DUSK;
        if (this.duskRow.visible)
            this.duskRow.set_subtitle(this._duskTime());
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

    _duskTime() {
        try {
            const settings = Gio.Settings.new('org.gnome.settings-daemon.plugins.color');
            const hours = Number(settings.get_double('night-light-schedule-from'));
            if (!Number.isFinite(hours))
                return '18:00';
            const total = ((Math.round(hours * 60) % 1440) + 1440) % 1440;
            return `${String(Math.floor(total / 60)).padStart(2, '0')}:` +
                `${String(total % 60).padStart(2, '0')}`;
        } catch (_) {
            return '18:00';
        }
    }

    _buildSafetyPage() {
        const page = this._page();
        this.deleteGuardGroup = new Adw.PreferencesGroup({
            title: t('Delete guard'),
            description: t('Optional protection for backups. When disabled, deletions ' +
                'are not limited.'),
        });
        this.deleteGuardRow = new Adw.SwitchRow({
            title: t('Protect against mass deletion'),
            subtitle: t('Stop a backup when it would delete too many files.'),
            active: this.job.options.deleteGuardEnabled !== false,
        });
        this.maxDeleteRow = new Adw.SpinRow({
            title: t('Maximum deletion (%)'),
            subtitle: t('Abort when a run would delete more than this percentage'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 100,
                step_increment: 1,
                page_increment: 10,
                value: Number(this.job.options.maxDeletePercent ?? 10),
            }),
        });
        this.maxDeleteMinimumRow = new Adw.SpinRow({
            title: t('Minimum deletion allowance (files)'),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 100000,
                step_increment: 1,
                page_increment: 10,
                value: Number(this.job.options.maxDeleteMinimum ?? 10),
            }),
        });
        this.deleteGuardRow.connect('notify::active', () => {
            this.maxDeleteRow.sensitive = this.deleteGuardRow.active;
            this.maxDeleteMinimumRow.sensitive = this.deleteGuardRow.active;
        });
        this.maxDeleteRow.sensitive = this.deleteGuardRow.active;
        this.maxDeleteMinimumRow.sensitive = this.deleteGuardRow.active;
        this.deleteGuardGroup.add(this.deleteGuardRow);
        this.deleteGuardGroup.add(this.maxDeleteRow);
        this.deleteGuardGroup.add(this.maxDeleteMinimumRow);
        page.add(this.deleteGuardGroup);
        const safety = new Adw.PreferencesGroup({
            title: t('Safety'),
            description: t('The defaults are suitable for most jobs.'),
        });
        this.bandwidthRow = new Adw.EntryRow({
            title: t('Bandwidth limit (e.g. 10M)'),
            text: this.job.options.bandwidthLimit || '',
        });
        this.notifyRow = new Adw.SwitchRow({
            title: t('Notify when the job finishes'),
            subtitle: t('Show a desktop notification after a completed backup.'),
            active: this.job.options.notifyOnComplete !== false,
        });
        safety.add(this.bandwidthRow);
        safety.add(this.notifyRow);
        page.add(safety);

        const advanced = new Adw.PreferencesGroup({title: t('Advanced')});
        this.advancedExpander = new Adw.ExpanderRow({
            title: t('Performance and metadata'),
            subtitle: t('Transfers, checkers, metadata and symbolic links'),
        });
        this.transfersRow = new Adw.SpinRow({
            title: t('Parallel transfers'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 64,
                step_increment: 1,
                page_increment: 4,
                value: Number(this.job.options.transfers || 4),
            }),
        });
        this.checkersRow = new Adw.SpinRow({
            title: t('Parallel checkers'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 64,
                step_increment: 1,
                page_increment: 4,
                value: Number(this.job.options.checkers || 8),
            }),
        });
        this.metadataRow = new Adw.SwitchRow({
            title: t('Preserve metadata'),
            active: Boolean(this.job.options.preserveMetadata),
        });
        this.symlinkRow = new Adw.SwitchRow({
            title: t('Follow symbolic links'),
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

    _buildReviewPage() {
        const page = this._page();
        const group = new Adw.PreferencesGroup({
            title: t('Review'),
            description: t('Review the job settings before saving.'),
        });
        this.reviewRows = {};
        for (const [key, label] of [
            ['type', t('Type')],
            ['name', t('Name')],
            ['source', t('Source')],
            ['content', t('Content')],
            ['filters', t('Filters')],
            ['destination', t('Destination')],
            ['schedule', t('Schedule')],
            ['safety', t('Safety')],
        ]) {
            this.reviewRows[key] = new Adw.ActionRow({title: label});
            group.add(this.reviewRows[key]);
        }
        page.add(group);
        return page;
    }

    _updateReview() {
        if (!this.reviewRows)
            return;
        const job = this._collectJob();
        const types = {
            type: job.type === JOB_TYPES.BACKUP ? t('Backup') : t('Sync'),
            name: job.name || '-',
            source: descriptorDisplay(job.source, this.volumes) || t('Not selected'),
            content: job.filters.include.length
                ? job.filters.include.join(', ')
                : t('All source content'),
            filters: job.filters.exclude.length
                ? job.filters.exclude.join(', ') : t('None'),
            destination: descriptorDisplay(job.destination, this.volumes) ||
                t('Not selected'),
            schedule: triggerLabel(job.trigger),
            safety: `${job.options.maxDeletePercent}%` +
                (job.type === JOB_TYPES.BACKUP
                    ? ` · ${job.backup.keepForever
                        ? t('keep versions forever')
                        : `${job.backup.retentionDays} ${t('days')}`}`
                    : ''),
        };
        for (const [key, value] of Object.entries(types))
            this.reviewRows[key].set_subtitle(String(value));
    }

    _showStep(index) {
        this._step = Math.max(this._firstStep,
            Math.min(STEP_TITLES.length - 1, index));
        const names = ['type', 'name', 'source', 'content', 'filters',
            'destination', 'newDestination', 'schedule', 'safety', 'review'];
        this.stack.set_visible_child_name(names[this._step]);
        if (this._step === 5 && this.existingGroup)
            this._renderExistingDestinations();
        const title = this.isDraft ? t('Continue job') : this.isNew ? t('New job') : t('Edit job');
        const position = this._step + 1 - this._firstStep;
        const total = STEP_TITLES.length - this._firstStep;
        this.windowTitle.title = `${title} · ` +
            `${STEP_TITLES[this._step]} (${position}/${total})`;
        this.backButton.visible = this._step > this._firstStep;
        this.nextButton.visible = this._step < STEP_TITLES.length - 1;
        this.saveButton.visible = this._step === STEP_TITLES.length - 1;
        this.runButton.visible = this._step === STEP_TITLES.length - 1;
        this.cancelButton.label = this._step >= 1 && (this.isNew || this.isDraft)
            ? t('Close') : t('Cancel');
        if (this._step === STEP_TITLES.length - 1)
            this._updateReview();
        if (this._ready)
            this._autosaveDraft(this._step);
    }

    _next() {
        if (this._validateStep(this._step))
            this._showStep(this._step + 1);
    }

    _validateStep(index) {
        if (index === 1 && !this.nameRow.text.trim()) {
            this._showError(t('Give the job a name.'));
            return false;
        }
        if (index === 2 && !this.sources.some(source => source.path || source.volumeUuid)) {
            this._showError(t('Choose at least one source folder.'));
            return false;
        }
        if (index === 5 && !this._destinationSelected()) {
            this._showError(t('Choose a destination.'));
            return false;
        }
        if (index === 5) {
            const compatibility = this._destinationCompatibilityError();
            if (compatibility) {
                this._showError(compatibility);
                return false;
            }
        }
        if (index === 6 && !this._destinationSelected()) {
            this._showError(t('Choose a destination.'));
            return false;
        }
        if (index === 6) {
            const compatibility = this._destinationCompatibilityError();
            if (compatibility) {
                this._showError(compatibility);
                return false;
            }
        }
        if (index === 7) {
            if (this.triggerMode === TRIGGER_MODES.INTERVAL && this._intervalMinutes() < 1) {
                this._showError(t('The interval must be at least one minute.'));
                return false;
            }
            if (this.triggerMode === TRIGGER_MODES.WEEKLY && this.dayOfWeekRow.selected < 0) {
                this._showError(t('Choose a day of the week.'));
                return false;
            }
            if ([TRIGGER_MODES.WEEKLY, TRIGGER_MODES.MONTHLY]
                .includes(this.triggerMode) && !isValidTime(this.timeRow.text)) {
                this._showError(t('Use a time in the HH:MM format (for example 18:00).'));
                return false;
            }
        }
        return true;
    }

    _showError(message) {
        const dialog = new Adw.AlertDialog({heading: t('Check this step'), body: message});
        dialog.add_response('ok', t('OK'));
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
            return t('This base is used by a legacy direct sync job and cannot be ' +
                'shared. Choose another destination.');
        }
        return t('Direct sync destinations cannot be shared with another job. ' +
            'Choose another destination or create a new SaveMe base.');
    }

    _renderSources() {
        if (!this.sourceRow)
            return;
        this.sources = this.sources.slice(0, 1);
        const source = this.sources[0] || {kind: 'local', path: ''};
        this.sources[0] = source;
        const selected = descriptorDisplay(source, this.volumes);
        this.sourceRow.set_subtitle(selected || t('Not selected'));
        const type = source.kind === 'remote' ? (() => {
            const remote = (this.parentWindow.snapshot?.remotes || [])
                .find(item => item.name === source.remote);
            return remote?.type || null;
        })() : 'local';
        for (const [provider, button] of this.sourceProviderButtons || []) {
            if (provider === type)
                button.add_css_class('suggested-action');
            else
                button.remove_css_class('suggested-action');
        }
    }

    _updateContentSummary() {
        if (!this.contentRow || !this.contentButton)
            return;
        const source = this.sources[0];
        const path = source ? localPathFor(source, this.volumes) : null;
        this.contentButton.sensitive = Boolean(path);
        if (!path) {
            this.contentRow.set_subtitle(
                t('Content selection is available for local source folders.'));
            return;
        }
        if (this.includes.length === 0) {
            this.contentRow.set_subtitle(t('All source content'));
            return;
        }
        const summary = this.includes.join(', ');
        this.contentRow.set_subtitle(`${this.includes.length} ${t('selected')}: ` +
            (summary.length > 80 ? `${summary.slice(0, 79)}…` : summary));
        this.contentRow.set_tooltip_text(summary);
    }

    _selectSyncContent() {
        const source = this.sources[0];
        const path = source ? localPathFor(source, this.volumes) : null;
        if (!path) {
            this.parentWindow.toast(t('Choose a local source folder first.'));
            return;
        }
        new SyncSelectionDialog(this.parentWindow, {
            rootPath: path,
            selected: this.includes,
            transientFor: this,
            onDone: includes => {
                this.includes = includes;
                this._updateContentSummary();
            },
        }).present();
    }

    _updateVisibility() {
        const type = this.typeRow.selected === 1 ? JOB_TYPES.BACKUP : JOB_TYPES.SYNC;
        if (type !== JOB_TYPES.BACKUP && this.sources.length > 1)
            this.sources = [this.sources[0]];
        if (this.sourcesGroup)
            this._renderSources();
        if (this.existingGroup)
            this._renderExistingDestinations();
        if (this.contentGroup)
            this._updateContentSummary();
        if (this.deleteGuardGroup)
            this.deleteGuardGroup.visible = type === JOB_TYPES.BACKUP;
        if (!this.triggerRow)
            return;
        this._syncTriggerOptions(this.triggerMode || this.job.trigger.mode);
        this._updateTriggerRows();
    }

    _setDestination(descriptor) {
        this.job.destination = descriptor;
        this.destinationRow?.set_subtitle(
            descriptorDisplay(descriptor, this.volumes) || t('Not selected'));
        this._updateProviderSelection();
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
            ? t('No accounts configured. Add one to use a cloud destination.')
            : `${remotes.length} ${t(remotes.length === 1 ? 'account configured.' : 'accounts configured.')} ` +
                t('Add, reconnect or delete accounts here.'));
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
            body: `${t('Current')}: ${descriptorDisplay(current, this.volumes) || t('Not selected')}`,
        });
        dialog.add_response('cancel', t('Cancel'));
        dialog.add_response('local', t('Local folder'));
        dialog.add_response('remote', t('Cloud remote'));
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
        const dialog = new Gtk.FileDialog({title: t('Choose folder'), modal: true});
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
        const source = this.sources[0] || {kind: 'local', path: ''};
        return normalizeJob({
            ...this.job,
            name: this.nameRow.text.trim(),
            type,
            source,
            sources: [source],
            destination: this.job.destination,
            trigger: {
                mode: this.triggerMode,
                intervalMinutes: this._intervalMinutes(),
                intervalValue: Number(this.intervalRow.value),
                intervalUnit: INTERVAL_UNITS[this.intervalUnitRow.selected] || 'hours',
                dayOfWeek: this.dayOfWeekRow.selected,
                dayOfMonth: Number(this.dayOfMonthRow.value),
                time: this.triggerMode === TRIGGER_MODES.DUSK
                    ? this._duskTime()
                    : (this.timeRow.text.trim() || '18:00'),
                idleOnly: this.idleRow.active,
            },
            filters: {
                exclude: String(this.filtersRow.text || '')
                    .split(',')
                    .map(value => value.trim())
                    .filter(Boolean),
                include: this.includes,
            },
            options: {
                ...this.job.options,
                maxDeletePercent: type === JOB_TYPES.BACKUP
                    ? Number(this.maxDeleteRow.value) : 100,
                maxDeleteMinimum: type === JOB_TYPES.BACKUP
                    ? Number(this.maxDeleteMinimumRow.value) : 0,
                deleteGuardEnabled: type === JOB_TYPES.BACKUP &&
                    this.deleteGuardRow.active,
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
        if (step < 1 || !this.nameRow?.text.trim())
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
                        this.parentWindow.toast(t('Draft saved. Continue later from Jobs.'));
                    }
                })
                .catch(e => this.parentWindow.toast(`${t('Cannot save draft')}: ${e.message}`))
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
        for (let step = 0; step < STEP_TITLES.length; step++) {
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
        const saver = new JobSaveDialog(this, job.name || job.id);
        saver.present();
        this._setSaving(true);
        try {
            const saved = await this.client.saveJob(job);
            saver.complete();
            this._saved = true;
            if (run)
                await this.client.runJob(saved.id, false, false);
            this.parentWindow.toast(run
                ? t('Job saved and run started.')
                : t('Job saved.'));
            this.parentWindow.refresh();
            saver.close();
            this.close();
        } catch (e) {
            saver.close();
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
            this.runButton.label = saving ? t('Saving…') : t('Save & Run');
    }

    _saveErrorMessage(error) {
        const message = cleanError(error.message);
        if (/timeout|timed out|tempo limite|tempo esgotado/i.test(message)) {
            return t('The operation took longer than expected. The job may still be ' +
                'finishing; check the Jobs list in a moment before trying again.');
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
                    this.parentWindow.toast(`${t('Job saved, but the run did not start')}: ${e.message}`);
            }
        }
        this.parentWindow.toast(run ? t('Job saved and run started.') : t('Job saved.'));
        this.parentWindow.refresh();
        this.close();
        return true;
    }
});
