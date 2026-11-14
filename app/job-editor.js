import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {VolumeResolver} from '../src/volumes.js';
import {AccountDialog} from './account-dialog.js';
import {RemoteBrowserDialog} from './remote-browser.js';
import {
    JOB_TYPES,
    TRIGGER_MODES,
    defaultJob,
    descriptorDisplay,
    normalizeJob,
    validateJob,
} from '../src/jobs.js';

const TRIGGER_LABELS = ['Real-time', 'Interval', 'Manual'];
const STEP_TITLES = ['General', 'Sources', 'Destination', 'Schedule', 'Safety'];

export const JobEditor = GObject.registerClass({
    GTypeName: 'SaveMeJobEditor',
}, class JobEditor extends Adw.Window {
    constructor(parentWindow, job = null) {
        super({
            transient_for: parentWindow,
            modal: true,
            title: job ? 'Edit job' : 'New job',
            default_width: 720,
            default_height: 700,
        });
        this.parentWindow = parentWindow;
        this.client = parentWindow.client;
        this.volumes = parentWindow.volumes || new VolumeResolver();
        this.isNew = !job;
        this.job = normalizeJob(job
            ? JSON.parse(JSON.stringify(job))
            : defaultJob());
        delete this.job.state;
        this.sources = (this.job.sources?.length ? this.job.sources : [this.job.source])
            .filter(Boolean)
            .map(source => JSON.parse(JSON.stringify(source)));
        if (this.sources.length === 0)
            this.sources.push({kind: 'local', path: ''});
        this._step = 0;
        this._build();
    }

    _build() {
        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        this.windowTitle = new Adw.WindowTitle({title: this.title});
        header.set_title_widget(this.windowTitle);

        const cancel = new Gtk.Button({label: 'Cancel'});
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
        this._showStep(0);
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
        const group = new Adw.PreferencesGroup({
            title: 'Destination',
            description: 'Choose the provider and the base folder. SaveMe will create its backup folder inside that base folder; it must not already exist.',
        });
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
        page.add(group);
        this._updateProviderSelection();
        return page;
    }

    _buildSchedulePage() {
        const page = this._page();
        const group = new Adw.PreferencesGroup({
            title: 'Schedule',
            description: 'Choose when the job should run.',
        });
        const triggerIndex = this.job.trigger.mode === TRIGGER_MODES.INTERVAL
            ? 1
            : this.job.trigger.mode === TRIGGER_MODES.MANUAL ? 2 : 0;
        this.triggerRow = new Adw.ComboRow({
            title: 'Mode',
            model: Gtk.StringList.new(TRIGGER_LABELS),
            selected: triggerIndex,
        });
        this.triggerRow.connect('notify::selected', () => this._updateVisibility());
        this.intervalRow = new Adw.SpinRow({
            title: 'Interval (minutes)',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 10080,
                step_increment: 1,
                page_increment: 30,
                value: Number(this.job.trigger.intervalMinutes || 60),
            }),
        });
        group.add(this.triggerRow);
        group.add(this.intervalRow);
        page.add(group);

        this.backupGroup = new Adw.PreferencesGroup({title: 'Backup'});
        this.retentionRow = new Adw.SpinRow({
            title: 'Keep versions for (days)',
            subtitle: '0 keeps versions forever',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 3650,
                step_increment: 1,
                page_increment: 30,
                value: Number(this.job.backup.retentionDays || 0),
            }),
        });
        this.backupGroup.add(this.retentionRow);
        page.add(this.backupGroup);
        return page;
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
        this.windowTitle.title = `${this.isNew ? 'New job' : 'Edit job'} · ` +
            `${STEP_TITLES[this._step]} (${this._step + 1}/${STEP_TITLES.length})`;
        this.backButton.visible = this._step > 0;
        this.nextButton.visible = this._step < STEP_TITLES.length - 1;
        this.saveButton.visible = this._step === STEP_TITLES.length - 1;
        this.runButton.visible = this._step === STEP_TITLES.length - 1;
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
        if (index === 3 && this.triggerRow.selected === 1 && this.intervalRow.value < 1) {
            this._showError('The interval must be at least one minute.');
            return false;
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
        if (this.backupGroup)
            this.backupGroup.visible = type === JOB_TYPES.BACKUP;
        if (this.intervalRow)
            this.intervalRow.visible = this.triggerRow.selected === 1;
        if (type === JOB_TYPES.BACKUP && this.isNew && this.triggerRow.selected === 0) {
            this.triggerRow.selected = 1;
            this.intervalRow.value = 60;
        }
        if (this.sourcesGroup)
            this._renderSources();
    }

    _setDestination(descriptor) {
        this.job.destination = descriptor;
        this.destinationRow.set_subtitle(
            descriptorDisplay(descriptor, this.volumes) || 'Not selected');
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
                onDone: () => this._pickProvider(type),
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
                onDone: () => this._pickSourceProvider(type, callback, currentDescriptor),
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
        const triggerMode = this.triggerRow.selected === 1
            ? TRIGGER_MODES.INTERVAL
            : this.triggerRow.selected === 2 ? TRIGGER_MODES.MANUAL : TRIGGER_MODES.REALTIME;
        return normalizeJob({
            ...this.job,
            name: this.nameRow.text.trim(),
            type,
            source: this.sources[0],
            sources: this.sources,
            destination: this.job.destination,
            trigger: {
                mode: triggerMode,
                intervalMinutes: Number(this.intervalRow.value),
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
                retentionDays: Number(this.retentionRow.value),
            },
            enabled: this.job.enabled !== false,
        });
    }

    async _save(run) {
        for (let step = 0; step < 4; step++) {
            if (!this._validateStep(step)) {
                this._showStep(step);
                return;
            }
        }
        const job = this._collectJob();
        delete job.state;
        const remotes = (this.parentWindow.snapshot?.remotes || []).map(remote => remote.name);
        const errors = validateJob(job, {remotes});
        if (errors.length > 0) {
            this._showError(errors.join('\n'));
            return;
        }
        try {
            const saved = await this.client.saveJob(job);
            if (run)
                await this.client.runJob(saved.id, false, false);
            this.parentWindow.toast(run
                ? 'Job saved and run started.'
                : 'Job saved.');
            this.parentWindow.refresh();
            this.close();
        } catch (e) {
            this._showError(e.message);
        }
    }
});
