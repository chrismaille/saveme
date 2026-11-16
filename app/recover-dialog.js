import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {RemoteBrowserDialog} from './remote-browser.js';
import {RestoreDialog} from './restore-dialog.js';
import {t} from '../src/i18n.js';

function destinationDisplay(descriptor) {
    if (!descriptor)
        return '';
    if (descriptor.kind === 'remote')
        return descriptor.remote
            ? `${descriptor.remote}:${descriptor.path || ''}`
            : descriptor.path || '';
    return descriptor.path || '';
}

export const RecoverDialog = GObject.registerClass({
    GTypeName: 'SaveMeRecoverDialog',
}, class RecoverDialog extends Adw.Window {
    constructor(parentWindow) {
        super({
            transient_for: parentWindow,
            modal: true,
            title: t('Recover backup'),
            default_width: 680,
            default_height: 600,
        });
        this.parentWindow = parentWindow;
        this.client = parentWindow.client;
        this.inspecting = false;
        this._build();
        this._chooseLocation();
    }

    _build() {
        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        header.set_title_widget(new Adw.WindowTitle({title: this.title}));
        const close = new Gtk.Button({label: t('Close')});
        close.connect('clicked', () => this.close());
        header.pack_start(close);
        this.chooseButton = new Gtk.Button({label: t('Choose folder')});
        this.chooseButton.connect('clicked', () => this._chooseLocation());
        header.pack_end(this.chooseButton);
        toolbar.add_top_bar(header);

        this.page = new Adw.PreferencesPage();
        const locationGroup = new Adw.PreferencesGroup({
            title: t('Backup location'),
            description: t('Select the SaveMe folder created by a previous installation.'),
        });
        this.locationRow = new Adw.ActionRow({
            title: t('Folder'),
            subtitle: t('Not selected'),
        });
        locationGroup.add(this.locationRow);
        this.page.add(locationGroup);

        this.statusRow = new Adw.ActionRow({
            title: t('Status'),
            subtitle: t('Choose a local or cloud SaveMe folder.'),
        });
        this.spinner = new Adw.Spinner({
            visible: false,
            valign: Gtk.Align.CENTER,
        });
        this.statusRow.add_suffix(this.spinner);
        locationGroup.add(this.statusRow);

        this.resultsGroup = new Adw.PreferencesGroup({title: t('Backups found')});
        this.page.add(this.resultsGroup);
        toolbar.set_content(this.page);
        this.set_content(toolbar);
    }

    _chooseLocation() {
        if (this.inspecting)
            return;
        const dialog = new Adw.AlertDialog({
            heading: t('Where is the SaveMe folder?'),
            body: t('Choose a local folder or browse a cloud remote.'),
        });
        dialog.add_response('cancel', t('Cancel'));
        dialog.add_response('local', t('Local folder'));
        dialog.add_response('remote', t('Cloud remote'));
        dialog.set_response_appearance('local', Adw.ResponseAppearance.SUGGESTED);
        dialog.connect('response', (_dialog, response) => {
            if (response === 'local')
                this._chooseLocal();
            else if (response === 'remote')
                this._chooseRemote();
        });
        dialog.present(this);
    }

    _chooseLocal() {
        const dialog = new Gtk.FileDialog({title: t('Choose SaveMe folder'), modal: true});
        dialog.select_folder(this, null, (source, result) => {
            try {
                const path = source.select_folder_finish(result).get_path();
                if (path)
                    this._inspect(path);
            } catch (_) {
                // Dialog dismissed.
            }
        });
    }

    _chooseRemote() {
        new RemoteBrowserDialog(this.parentWindow, {
            mode: 'pick',
            transientFor: this,
            onSelect: selected => {
                const path = `${selected.remote}:${selected.path || ''}`;
                this._inspect(path);
            },
        }).present();
    }

    _clearResults() {
        let child = this.resultsGroup.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this.resultsGroup.remove(child);
            child = next;
        }
    }

    async _inspect(path) {
        if (this.inspecting)
            return;
        this.inspecting = true;
        this.chooseButton.sensitive = false;
        this.locationRow.set_subtitle(path);
        this.statusRow.set_subtitle(t('Checking backups…'));
        this.spinner.visible = true;
        this._clearResults();
        try {
            const result = await this.client.inspectBackup(path);
            this._render(result);
        } catch (e) {
            this.statusRow.set_subtitle(
                t('Cannot inspect backup: {message}', {message: e.message}));
        } finally {
            this.spinner.visible = false;
            this.chooseButton.sensitive = true;
            this.inspecting = false;
        }
    }

    _render(result) {
        this._clearResults();
        const jobs = result.jobs || [];
        const recoverable = jobs.filter(entry => entry.job).length;
        const withoutManifest = jobs.length - recoverable;
        if (jobs.length === 0) {
            this.statusRow.set_subtitle(t('No SaveMe jobs found.'));
        } else if (recoverable === 0) {
            this.statusRow.set_subtitle(t('No recoverable jobs found.'));
        } else {
            let subtitle = t('{count} job(s) found.', {count: recoverable});
            if (withoutManifest > 0) {
                subtitle += ` · ${t('{count} folder(s) without manifest.',
                    {count: withoutManifest})}`;
            }
            this.statusRow.set_subtitle(subtitle);
        }
        for (const entry of jobs) {
            const job = entry.job;
            if (job) {
                const sources = entry.sources || [];
                const missing = sources.filter(source => source.exists === false).length;
                let subtitle = `${job.type === 'backup' ? t('Backup') : t('Sync')} · ` +
                    `${sources.length} ${sources.length === 1 ? t('source') : t('sources')}`;
                if (missing > 0)
                    subtitle += ` · ${t('{count} source(s) missing.', {count: missing})}`;
                else if (sources.length > 0)
                    subtitle += ` · ${t('sources found')}`;
                if (entry.idMismatch)
                    subtitle += ` · ${t('id differs from the folder name')}`;
                const row = new Adw.ActionRow({
                    title: job.name || entry.id,
                    subtitle,
                });
                const review = new Gtk.Button({
                    label: t('Review & import'),
                    valign: Gtk.Align.CENTER,
                    css_classes: ['suggested-action'],
                });
                review.connect('clicked', () => this._confirmImport(entry, result));
                row.add_suffix(review);
                this.resultsGroup.add(row);
                continue;
            }
            const row = new Adw.ActionRow({
                title: entry.id,
                subtitle: entry.legacy
                    ? t('Folder without manifest. Recreate this job manually.')
                    : t('Cannot read this folder.'),
            });
            if (entry.legacy && entry.type === 'sync' && result.destination) {
                const recreate = new Gtk.Button({
                    label: t('Recreate sync job'),
                    valign: Gtk.Align.CENTER,
                });
                recreate.connect('clicked', () => this._recreateLegacy(entry, result));
                row.add_suffix(recreate);
            } else {
                row.add_suffix(new Gtk.Label({
                    label: entry.legacy ? t('No manifest') : t('Unreadable'),
                    css_classes: ['dim-label'],
                }));
            }
            this.resultsGroup.add(row);
        }
    }

    _recreateLegacy(entry, result) {
        if (!result.destination) {
            this.statusRow.set_subtitle(t('The selected folder does not look like a SaveMe base.'));
            return;
        }
        const dialog = new Adw.AlertDialog({
            heading: t('Recreate sync job?'),
            body: t('Choose the original source folder. The job is imported disabled ' +
                'and keeps using this destination.'),
        });
        dialog.add_response('cancel', t('Cancel'));
        dialog.add_response('local', t('Local folder'));
        dialog.add_response('remote', t('Cloud remote'));
        dialog.set_response_appearance('local', Adw.ResponseAppearance.SUGGESTED);
        dialog.connect('response', (_dialog, response) => {
            if (response === 'local') {
                const picker = new Gtk.FileDialog({
                    title: t('Choose source folder'),
                    modal: true,
                });
                picker.select_folder(this, null, (source, pickResult) => {
                    try {
                        const path = source.select_folder_finish(pickResult).get_path();
                        if (path)
                            this._importLegacySync(entry, result, {
                                kind: 'local',
                                path,
                            });
                    } catch (_) {
                        // Dialog dismissed.
                    }
                });
            } else if (response === 'remote') {
                new RemoteBrowserDialog(this.parentWindow, {
                    mode: 'pick',
                    transientFor: this,
                    onSelect: descriptor => this._importLegacySync(entry, result, descriptor),
                }).present();
            }
        });
        dialog.present(this);
    }

    async _importLegacySync(entry, result, source) {
        try {
            const saved = await this.client.importJob({
                id: entry.id,
                name: entry.id,
                type: 'sync',
                source,
                sources: [source],
                destination: result.destination,
                destinationLayout: 'saveMe',
                trigger: {mode: 'manual'},
                recovered: true,
                enabled: false,
                filters: {exclude: [], include: []},
            });
            this.parentWindow.refresh();
            this.parentWindow.toast(
                t('Sync job recreated. Review the settings before enabling it.'));
            this.close();
            return saved;
        } catch (e) {
            const dialog = new Adw.AlertDialog({
                heading: t('Cannot import backup'),
                body: e.message,
            });
            dialog.add_response('ok', t('OK'));
            dialog.present(this);
            return null;
        }
    }

    _confirmImport(entry, result) {
        const job = entry.job;
        const sources = entry.sources || [];
        const destination = destinationDisplay(result.destination);
        const existing = (this.parentWindow.snapshot?.jobs || [])
            .some(item => item.id === entry.id);
        const lines = [];
        if (destination)
            lines.push(t('Destination base: {path}', {path: destination}));
        if (sources.length > 0) {
            lines.push(t('Sources:'));
            for (const source of sources) {
                const suffix = source.exists === true
                    ? t('found')
                    : source.exists === false
                        ? t('not found')
                        : source.remote ? t('remote, not checked') : t('cannot check');
                const symbol = source.exists === true ? '✓' : source.exists === false ? '✗' : '•';
                lines.push(`${symbol} ${source.path} (${suffix})`);
            }
        }
        if (sources.some(source => source.exists === false)) {
            lines.push(t('Missing sources stay configured. The job is imported disabled.'));
        }
        if (existing)
            lines.push(t('A job with this ID already exists and will be replaced.'));
        const dialog = new Adw.AlertDialog({
            heading: t('Import job?'),
            body: lines.join('\n'),
        });
        dialog.add_response('cancel', t('Cancel'));
        dialog.add_response('import', t('Import job'));
        if (job.type === 'backup')
            dialog.add_response('restore', t('Import & restore'));
        dialog.set_response_appearance('import', Adw.ResponseAppearance.SUGGESTED);
        dialog.connect('response', (_dialog, response) => {
            if (response === 'import')
                this._import(entry, result, false);
            else if (response === 'restore')
                this._import(entry, result, true);
        });
        dialog.present(this);
    }

    async _import(entry, result, restore) {
        try {
            const job = JSON.parse(JSON.stringify(entry.job));
            job.id = entry.id;
            if (result.destination)
                job.destination = result.destination;
            job.destinationLayout = 'saveMe';
            const saved = await this.client.importJob(job);
            this.parentWindow.refresh();
            if (restore && saved.type === 'backup')
                new RestoreDialog(this.parentWindow, saved).present();
            else
                this.parentWindow.toast(
                    t('Job imported. Review the sources before enabling it.'));
            this.close();
        } catch (e) {
            const dialog = new Adw.AlertDialog({
                heading: t('Cannot import backup'),
                body: e.message,
            });
            dialog.add_response('ok', t('OK'));
            dialog.present(this);
        }
    }
});
