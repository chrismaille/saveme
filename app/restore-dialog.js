import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {RemoteBrowserDialog} from './remote-browser.js';

export const RestoreDialog = GObject.registerClass({
    GTypeName: 'SaveMeRestoreDialog',
}, class RestoreDialog extends Adw.Window {
    constructor(parentWindow, job) {
        super({
            transient_for: parentWindow,
            modal: true,
            title: `Restore — ${job.name}`,
            default_width: 680,
            default_height: 620,
        });
        this.parentWindow = parentWindow;
        this.client = parentWindow.client;
        this.job = job;
        this.versions = [];
        this.target = null;
        this._build();
        this._loadVersions();
    }

    _build() {
        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        header.set_title_widget(new Adw.WindowTitle({title: this.title}));
        const cancel = new Gtk.Button({label: 'Close'});
        cancel.connect('clicked', () => this.close());
        header.pack_start(cancel);
        this.restoreButton = new Gtk.Button({
            label: 'Restore',
            css_classes: ['suggested-action'],
        });
        this.restoreButton.connect('clicked', () => this._restore());
        header.pack_end(this.restoreButton);
        toolbar.add_top_bar(header);

        const page = new Adw.PreferencesPage();
        const sourceGroup = new Adw.PreferencesGroup({
            title: 'Source',
            description: 'Choose the current backup or a dated version, then browse to a file or folder. Leave the path empty to restore the selected source.',
        });
        this.versionRow = new Adw.ComboRow({
            title: 'Version',
            model: Gtk.StringList.new(['Current backup']),
            selected: 0,
        });
        this.versionRow.connect('notify::selected', () => {
            if (this.pathRow)
                this.pathRow.text = '';
        });
        sourceGroup.add(this.versionRow);
        this.pathRow = new Adw.EntryRow({
            title: 'File or folder inside the backup',
            text: '',
        });
        const browse = new Gtk.Button({
            label: 'Browse',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        browse.connect('clicked', () => this._browse());
        this.pathRow.add_suffix(browse);
        sourceGroup.add(this.pathRow);
        page.add(sourceGroup);

        const targetGroup = new Adw.PreferencesGroup({title: 'Target'});
        this.targetRow = new Adw.ActionRow({
            title: 'Target folder',
            subtitle: 'Not selected',
        });
        const choose = new Gtk.Button({
            label: 'Choose',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        choose.connect('clicked', () => this._chooseTarget());
        this.targetRow.add_suffix(choose);
        targetGroup.add(this.targetRow);
        this.dryRunRow = new Adw.SwitchRow({
            title: 'Dry run',
            subtitle: 'Show what would be restored without writing files',
            active: true,
        });
        targetGroup.add(this.dryRunRow);
        page.add(targetGroup);

        toolbar.set_content(page);
        this.set_content(toolbar);
    }

    async _loadVersions() {
        try {
            const versions = await this.client.listVersions(this.job.id);
            this.versions = versions;
            const labels = ['Current backup',
                ...versions.map(version => {
                    if (!version.date)
                        return version.name;
                    return new Date(version.date).toLocaleString();
                })];
            this.versionRow.model = Gtk.StringList.new(labels);
            this.versionRow.selected = 0;
        } catch (e) {
            this.parentWindow.toast(`Cannot list versions: ${e.message}`);
        }
    }

    _selectedVersion() {
        const index = this.versionRow.selected;
        return index > 0 ? this.versions[index - 1]?.name || '' : '';
    }

    _browse() {
        new RemoteBrowserDialog(this.parentWindow, {
            mode: 'pick',
            jobId: this.job.id,
            version: this._selectedVersion(),
            path: String(this.pathRow.text || '').trim(),
            transientFor: this,
            onSelect: selected => {
                this.pathRow.text = selected.path || '';
            },
        }).present();
    }

    _chooseTarget() {
        const dialog = new Gtk.FileDialog({title: 'Choose target folder', modal: true});
        dialog.select_folder(this, null, (source, result) => {
            try {
                const file = source.select_folder_finish(result);
                const path = file.get_path();
                if (path) {
                    this.target = path;
                    this.targetRow.set_subtitle(path);
                }
            } catch (_) {
                // Dialog dismissed.
            }
        });
    }

    async _restore() {
        if (!this.target) {
            this.parentWindow.toast('Choose a target folder first.');
            return;
        }
        if (!GLib.file_test(this.target, GLib.FileTest.IS_DIR)) {
            this.parentWindow.toast('Target folder does not exist.');
            return;
        }
        const version = this._selectedVersion();
        const path = String(this.pathRow.text || '').trim();
        if (version && !path) {
            const dialog = new Adw.AlertDialog({
                heading: 'Restore changed files only?',
                body: 'A dated version contains only files that were overwritten or deleted in that batch. ' +
                    'To restore the complete latest backup, choose Current backup. ' +
                    'To restore a single file from this date, browse and select it.',
            });
            dialog.add_response('cancel', 'Cancel');
            dialog.add_response('continue', 'Continue');
            dialog.set_response_appearance('continue', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.connect('response', (_dialog, response) => {
                if (response === 'continue')
                    this._performRestore({version, path});
            });
            dialog.present(this);
            return;
        }
        await this._performRestore({version, path});
    }

    async _performRestore({version, path}) {
        const payload = {
            jobId: this.job.id,
            version,
            path,
            target: this.target,
            dryRun: Boolean(this.dryRunRow.active),
        };
        this.restoreButton.sensitive = false;
        this.restoreButton.label = 'Restoring…';
        try {
            await this.client.restore(payload);
            this.parentWindow.toast(payload.dryRun
                ? 'Dry run completed. Check the target folder.'
                : 'Restore completed.');
            if (!payload.dryRun)
                this.close();
        } catch (e) {
            const dialog = new Adw.AlertDialog({
                heading: 'Restore failed',
                body: e.message,
            });
            dialog.add_response('ok', 'OK');
            dialog.present(this);
        } finally {
            this.restoreButton.sensitive = true;
            this.restoreButton.label = 'Restore';
        }
    }
});
