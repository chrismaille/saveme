import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {RemoteBrowserDialog} from './remote-browser.js';
import {RestoreDialog} from './restore-dialog.js';

export const RecoverDialog = GObject.registerClass({
    GTypeName: 'SaveMeRecoverDialog',
}, class RecoverDialog extends Adw.Window {
    constructor(parentWindow) {
        super({
            transient_for: parentWindow,
            modal: true,
            title: 'Recover backup',
            default_width: 680,
            default_height: 600,
        });
        this.parentWindow = parentWindow;
        this.client = parentWindow.client;
        this._build();
        this._chooseLocation();
    }

    _build() {
        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        header.set_title_widget(new Adw.WindowTitle({title: this.title}));
        const close = new Gtk.Button({label: 'Close'});
        close.connect('clicked', () => this.close());
        header.pack_start(close);
        const choose = new Gtk.Button({label: 'Choose folder'});
        choose.connect('clicked', () => this._chooseLocation());
        header.pack_end(choose);
        toolbar.add_top_bar(header);

        this.page = new Adw.PreferencesPage();
        const locationGroup = new Adw.PreferencesGroup({
            title: 'Backup location',
            description: 'Select the SaveMe folder created by a previous installation.',
        });
        this.locationRow = new Adw.ActionRow({
            title: 'Folder',
            subtitle: 'Not selected',
        });
        locationGroup.add(this.locationRow);
        this.page.add(locationGroup);

        this.statusRow = new Adw.ActionRow({
            title: 'Status',
            subtitle: 'Choose a local or cloud SaveMe folder.',
        });
        locationGroup.add(this.statusRow);

        this.resultsGroup = new Adw.PreferencesGroup({title: 'Backups found'});
        this.page.add(this.resultsGroup);
        toolbar.set_content(this.page);
        this.set_content(toolbar);
    }

    _chooseLocation() {
        const dialog = new Adw.AlertDialog({
            heading: 'Where is the SaveMe folder?',
            body: 'Choose a local folder or browse a cloud remote.',
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('local', 'Local folder');
        dialog.add_response('remote', 'Cloud remote');
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
        const dialog = new Gtk.FileDialog({title: 'Choose SaveMe folder', modal: true});
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

    async _inspect(path) {
        this.locationRow.set_subtitle(path);
        this.statusRow.set_subtitle('Inspecting manifests…');
        try {
            const result = await this.client.inspectBackup(path);
            this._render(result);
        } catch (e) {
            this.statusRow.set_subtitle(`Cannot inspect backup: ${e.message}`);
        }
    }

    _render(result) {
        let child = this.resultsGroup.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this.resultsGroup.remove(child);
            child = next;
        }
        const jobs = result.jobs || [];
        this.statusRow.set_subtitle(
            jobs.length ? `${jobs.length} backup(s) found.` : 'No SaveMe backups found.');
        for (const entry of jobs) {
            const job = entry.job;
            const row = new Adw.ActionRow({
                title: job?.name || entry.id,
                subtitle: job
                    ? `${job.id} · ${job.sources?.length || 1} source(s) · ` +
                        `${job.trigger?.mode || 'manual'}`
                    : entry.error || 'Missing manifest',
            });
            if (job) {
                const restore = new Gtk.Button({
                    label: 'Import & restore',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['suggested-action'],
                });
                restore.connect('clicked', () => this._import(job));
                row.add_suffix(restore);
            }
            this.resultsGroup.add(row);
        }
    }

    async _import(job) {
        try {
            const saved = await this.client.importJob(job);
            this.parentWindow.toast('Backup job imported. Choose a restore target.');
            new RestoreDialog(this.parentWindow, saved).present();
            this.close();
        } catch (e) {
            const dialog = new Adw.AlertDialog({
                heading: 'Cannot import backup',
                body: e.message,
            });
            dialog.add_response('ok', 'OK');
            dialog.present(this);
        }
    }
});
