import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {RemoteBrowserDialog} from './remote-browser.js';
import {RecoveryImportDialog} from './recovery-import-dialog.js';
import {t} from '../src/i18n.js';


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
                    ? entry.type === 'sync'
                        ? t('Sync job without manifest. It cannot be recovered ' +
                            'automatically. The files are in the current folder.')
                        : t('Backup without manifest. It cannot be recovered ' +
                            'automatically. The files are in the current folder.')
                    : t('Cannot read this folder. Open the current folder to inspect ' +
                        'the files.'),
            });
            if (entry.backupPath) {
                const open = new Gtk.Button({
                    label: t('Open current folder'),
                    valign: Gtk.Align.CENTER,
                });
                open.connect('clicked', () => this._openCurrent(entry));
                row.add_suffix(open);
            }
            this.resultsGroup.add(row);
        }
    }

    _openCurrent(entry) {
        const current = `${String(entry.backupPath).replace(/\/+$/, '')}/current`;
        const remote = /^([^:]+):(.*)$/.exec(current);
        const remoteNames = (this.parentWindow.snapshot?.remotes || [])
            .map(item => item.name);
        if (remote && remoteNames.includes(remote[1])) {
            new RemoteBrowserDialog(this.parentWindow, {
                mode: 'browse',
                remote: remote[1],
                path: remote[2],
                transientFor: this,
            }).present();
            return;
        }
        try {
            this.parentWindow.launcher.openPath(current);
        } catch (e) {
            this.statusRow.set_subtitle(t('Cannot open folder: {message}', {
                message: e.message,
            }));
        }
    }

    _confirmImport(entry, result) {
        new RecoveryImportDialog(this.parentWindow, this, entry, result).present();
    }
});
