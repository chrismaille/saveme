import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {VolumeResolver} from '../src/volumes.js';
import {RemoteBrowserDialog} from './remote-browser.js';
import {
    JOB_TYPES,
    TRIGGER_MODES,
    defaultJob,
    descriptorDisplay,
    normalizeJob,
    validateJob,
} from '../src/jobs.js';

const TYPE_LABELS = ['Sync', 'Backup'];
const TRIGGER_LABELS = ['Real-time', 'Interval', 'Manual'];

export const JobEditor = GObject.registerClass({
    GTypeName: 'SaveMeJobEditor',
}, class JobEditor extends Adw.Window {
    constructor(parentWindow, job = null) {
        super({
            transient_for: parentWindow,
            modal: true,
            title: job ? 'Edit job' : 'New job',
            default_width: 680,
            default_height: 780,
        });
        this.parentWindow = parentWindow;
        this.client = parentWindow.client;
        this.volumes = parentWindow.volumes || new VolumeResolver();
        this.isNew = !job;
        this.job = normalizeJob(job
            ? JSON.parse(JSON.stringify(job))
            : defaultJob());
        delete this.job.state;
        this._build();
    }

    _build() {
        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        header.set_title_widget(new Adw.WindowTitle({title: this.title}));
        const cancelButton = new Gtk.Button({label: 'Cancel'});
        cancelButton.connect('clicked', () => this.close());
        header.pack_start(cancelButton);
        const saveButton = new Gtk.Button({
            label: 'Save',
            css_classes: ['suggested-action'],
        });
        saveButton.connect('clicked', () => this._save(false));
        header.pack_end(saveButton);
        const dryButton = new Gtk.Button({label: 'Save & Dry Run'});
        dryButton.connect('clicked', () => this._save(true));
        header.pack_end(dryButton);
        toolbar.add_top_bar(header);

        const page = new Adw.PreferencesPage();
        const general = new Adw.PreferencesGroup({
            title: 'General',
            description: this.isNew ? '' : 'The job type cannot be changed after creation.',
        });
        this.nameRow = new Adw.EntryRow({
            title: 'Name',
            text: this.job.name || '',
        });
        this.typeRow = new Adw.ComboRow({
            title: 'Type',
            model: Gtk.StringList.new(TYPE_LABELS),
            selected: this.job.type === JOB_TYPES.BACKUP ? 1 : 0,
        });
        this.typeRow.sensitive = this.isNew;
        this.typeRow.connect('notify::selected', () => this._updateVisibility());
        general.add(this.nameRow);
        general.add(this.typeRow);
        page.add(general);

        const locations = new Adw.PreferencesGroup({
            title: 'Source and destination',
            description: 'Changing the destination of an existing sync job does not move files already copied; the next run starts a fresh mirror at the new destination.',
        });
        this.sourceRow = new Adw.ActionRow({
            title: 'Source',
            subtitle: descriptorDisplay(this.job.source, this.volumes),
        });
        this._addChooseButton(this.sourceRow, () => {
            this._chooseDescriptor('Source', this.job.source, descriptor => {
                this.job.source = descriptor;
                this.sourceRow.set_subtitle(descriptorDisplay(descriptor, this.volumes));
            });
        });
        this.destinationRow = new Adw.ActionRow({
            title: 'Destination',
            subtitle: descriptorDisplay(this.job.destination, this.volumes),
        });
        this._addChooseButton(this.destinationRow, () => {
            this._chooseDescriptor('Destination', this.job.destination, descriptor => {
                this.job.destination = descriptor;
                this.destinationRow.set_subtitle(descriptorDisplay(descriptor, this.volumes));
            });
        });
        locations.add(this.sourceRow);
        locations.add(this.destinationRow);
        page.add(locations);

        const schedule = new Adw.PreferencesGroup({title: 'Schedule'});
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
        schedule.add(this.triggerRow);
        schedule.add(this.intervalRow);
        page.add(schedule);

        this.backupGroup = new Adw.PreferencesGroup({
            title: 'Backup',
            description: 'Backups are stored in <destination>/SaveMe/<job-id>/current. Previous and deleted files go to <destination>/SaveMe/<job-id>/versions/<date>.',
        });
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

        const options = new Adw.PreferencesGroup({title: 'Safety and performance'});
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
            subtitle: 'Ignore the percentage below this absolute count',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 100000,
                step_increment: 1,
                page_increment: 10,
                value: Number(this.job.options.maxDeleteMinimum ?? 10),
            }),
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
        this.bandwidthRow = new Adw.EntryRow({
            title: 'Bandwidth limit (e.g. 10M)',
            text: this.job.options.bandwidthLimit || '',
        });
        this.metadataRow = new Adw.SwitchRow({
            title: 'Preserve metadata',
            active: Boolean(this.job.options.preserveMetadata),
        });
        this.symlinkRow = new Adw.SwitchRow({
            title: 'Follow symbolic links',
            active: Boolean(this.job.options.followSymlinks),
        });
        options.add(this.maxDeleteRow);
        options.add(this.maxDeleteMinimumRow);
        options.add(this.transfersRow);
        options.add(this.checkersRow);
        options.add(this.bandwidthRow);
        options.add(this.metadataRow);
        options.add(this.symlinkRow);
        page.add(options);

        const filters = new Adw.PreferencesGroup({title: 'Filters'});
        this.filtersRow = new Adw.EntryRow({
            title: 'Exclude patterns (comma-separated)',
            text: (this.job.filters.exclude || []).join(', '),
        });
        filters.add(this.filtersRow);
        page.add(filters);

        toolbar.set_content(page);
        this.set_content(toolbar);
        this._updateVisibility();
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

    _updateVisibility() {
        const type = this.typeRow.selected === 1 ? JOB_TYPES.BACKUP : JOB_TYPES.SYNC;
        this.backupGroup.visible = type === JOB_TYPES.BACKUP;
        this.intervalRow.visible = this.triggerRow.selected === 1;
    }

    _chooseDescriptor(title, current, callback) {
        const dialog = new Adw.AlertDialog({
            heading: title,
            body: `Current: ${descriptorDisplay(current, this.volumes)}`,
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
            source: this.job.source,
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
            },
            backup: {
                retentionDays: Number(this.retentionRow.value),
            },
            enabled: this.job.enabled !== false,
        });
    }

    async _save(dryRun) {
        const job = this._collectJob();
        delete job.state;
        const remotes = (this.parentWindow.snapshot?.remotes || []).map(remote => remote.name);
        const errors = validateJob(job, {remotes});
        if (errors.length > 0) {
            const dialog = new Adw.AlertDialog({
                heading: 'Cannot save job',
                body: errors.join('\n'),
            });
            dialog.add_response('ok', 'OK');
            dialog.present(this);
            return;
        }
        try {
            const saved = await this.client.saveJob(job);
            this.parentWindow.toast(dryRun ? 'Job saved. Starting dry run.' : 'Job saved.');
            if (dryRun)
                await this.client.runJob(saved.id, true, false);
            this.parentWindow.refresh();
            this.close();
        } catch (e) {
            const dialog = new Adw.AlertDialog({
                heading: 'Cannot save job',
                body: e.message,
            });
            dialog.add_response('ok', 'OK');
            dialog.present(this);
        }
    }
});
