import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {RemoteBrowserDialog} from './remote-browser.js';
import {RecoveryImportDialog} from './recovery-import-dialog.js';
import {RestoreDialog} from './restore-dialog.js';
import {t} from '../src/i18n.js';

const MODULE_DIR = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const PROVIDERS = [
    {type: 'local', label: 'Local folder', icon: 'drive-harddisk-symbolic'},
    {type: 'drive', label: 'Google Drive', logo: 'google-drive.png'},
    {type: 'onedrive', label: 'Microsoft OneDrive', logo: 'onedrive.png'},
    {type: 'dropbox', label: 'Dropbox', logo: 'dropbox.png'},
    {type: 'nextcloud', label: 'Nextcloud', logo: 'nextcloud.png'},
    {type: 's3', label: 'S3 compatible', logo: 's3.png'},
    {type: 'pcloud', label: 'pCloud', logo: 'pcloud.png'},
];

export const RecoverDialog = GObject.registerClass({
    GTypeName: 'SaveMeRecoverDialog',
}, class RecoverDialog extends Adw.Window {
    constructor(parentWindow, {mode = 'import'} = {}) {
        super({
            transient_for: parentWindow,
            modal: true,
            title: mode === 'restore' ? t('Restore') : t('Find jobs'),
            default_width: 760,
            default_height: 680,
        });
        this.parentWindow = parentWindow;
        this.client = parentWindow.client;
        this.mode = mode;
        this.inspecting = false;
        this._build();
    }

    _build() {
        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        header.set_title_widget(new Adw.WindowTitle({
            title: this.mode === 'restore' ? t('Restore') : t('Find jobs'),
        }));
        const close = new Gtk.Button({label: t('Close')});
        close.connect('clicked', () => this.close());
        header.pack_start(close);
        this.backButton = new Gtk.Button({
            icon_name: 'go-previous-symbolic',
            tooltip_text: t('Back'),
            css_classes: ['flat'],
            visible: false,
        });
        this.backButton.connect('clicked', () => this._showProviders());
        header.pack_start(this.backButton);
        toolbar.add_top_bar(header);

        this.stack = new Gtk.Stack({
            transition_type: Gtk.StackTransitionType.SLIDE_LEFT_RIGHT,
            transition_duration: 180,
        });
        this.stack.add_named(this._buildProviderPage(), 'provider');
        this.stack.add_named(this._buildResultsPage(), 'results');
        toolbar.set_content(this.stack);
        this.set_content(toolbar);
        this._showProviders();
    }

    _buildProviderPage() {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: t('Where is the SaveMe folder?'),
            description: this.mode === 'restore'
                ? t('Choose the service that contains the SaveMe folder to restore from.')
                : t('Choose the service that contains the SaveMe folders with the jobs ' +
                    'you want to bring back.'),
        });
        const flow = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE,
            max_children_per_line: 3,
            column_spacing: 12,
            row_spacing: 12,
            homogeneous: true,
            margin_top: 8,
            margin_bottom: 8,
        });
        for (const provider of PROVIDERS) {
            const content = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 10,
                margin_top: 14,
                margin_bottom: 14,
                margin_start: 14,
                margin_end: 14,
            });
            if (provider.logo) {
                const image = Gtk.Image.new_from_file(
                    GLib.build_filenamev([MODULE_DIR, '..', 'assets', provider.logo]));
                image.set_pixel_size(56);
                content.append(image);
            } else {
                content.append(new Gtk.Image({
                    icon_name: provider.icon,
                    pixel_size: 56,
                }));
            }
            content.append(new Gtk.Label({
                label: t(provider.label),
                xalign: 0.5,
                justify: Gtk.Justification.CENTER,
                css_classes: ['title-4'],
            }));
            const button = new Gtk.Button({
                height_request: 140,
                hexpand: true,
                css_classes: ['card'],
                child: content,
            });
            button.connect('clicked', () => this._chooseProvider(provider.type));
            flow.append(button);
        }
        group.add(flow);
        page.add(group);
        return page;
    }

    _buildResultsPage() {
        const page = new Adw.PreferencesPage();
        const locationGroup = new Adw.PreferencesGroup({title: t('Backup location')});
        this.locationRow = new Adw.ActionRow({
            title: t('Folder'),
            subtitle: t('Not selected'),
        });
        locationGroup.add(this.locationRow);
        this.statusRow = new Adw.ActionRow({
            title: t('Status'),
            subtitle: t('Choose a service to continue.'),
        });
        this.spinner = new Adw.Spinner({
            visible: false,
            valign: Gtk.Align.CENTER,
        });
        this.statusRow.add_suffix(this.spinner);
        locationGroup.add(this.statusRow);
        page.add(locationGroup);
        this.resultsGroup = new Adw.PreferencesGroup({title: t('Backups found')});
        page.add(this.resultsGroup);
        return page;
    }

    _showProviders() {
        this.backButton.visible = false;
        this.inspecting = false;
        this.stack.set_visible_child_name('provider');
    }

    _chooseProvider(type) {
        if (type === 'local') {
            const dialog = new Gtk.FileDialog({
                title: t('Choose SaveMe folder'),
                modal: true,
            });
            dialog.select_folder(this, null, (source, result) => {
                try {
                    const path = source.select_folder_finish(result).get_path();
                    if (path)
                        this._inspect(path);
                } catch (_) {
                    // Dialog dismissed.
                }
            });
            return;
        }
        new RemoteBrowserDialog(this.parentWindow, {
            mode: 'pick',
            remoteType: type,
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
        this.backButton.visible = true;
        this.stack.set_visible_child_name('results');
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
                const action = new Gtk.Button({
                    label: this.mode === 'restore' && job.type !== 'backup'
                        ? t('Open current folder')
                        : this.mode === 'restore'
                            ? t('Restore')
                            : t('Review & import'),
                    valign: Gtk.Align.CENTER,
                    css_classes: ['suggested-action'],
                });
                if (this.mode === 'restore' && job.type === 'backup')
                    action.connect('clicked', () => this._restoreEntry(entry, result));
                else if (this.mode === 'restore')
                    action.connect('clicked', () => this._openCurrent(entry));
                else
                    action.connect('clicked', () => this._confirmImport(entry, result));
                row.add_suffix(action);
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
        new RecoveryImportDialog(this.parentWindow, this, entry, result, {
            allowRestore: false,
        }).present();
    }

    async _restoreEntry(entry, result) {
        const job = JSON.parse(JSON.stringify(entry.job));
        job.id = entry.id;
        if (result.destination)
            job.destination = result.destination;
        job.destinationLayout = 'saveMe';
        try {
            const saved = await this.client.importJob(job);
            await this.parentWindow.refresh();
            new RestoreDialog(this.parentWindow, saved, {
                temporaryJob: true,
            }).present();
            this.close();
        } catch (e) {
            this.statusRow.set_subtitle(t('Cannot import backup: {message}', {
                message: e.message,
            }));
        }
    }
});
