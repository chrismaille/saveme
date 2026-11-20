import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
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

function joinPath(base, relative) {
    if (!base)
        return relative;
    return base.endsWith(':') || base.endsWith('/')
        ? `${base}${relative}`
        : `${base}/${relative}`;
}

function sourceIcon(source) {
    if (source.remote)
        return 'folder-remote-symbolic';
    return source.exists === false ? 'dialog-warning-symbolic' : 'folder-symbolic';
}

function sourceDescription(source) {
    if (source.exists === true)
        return t('Found. SaveMe will use this folder as the source.');
    if (source.exists === false) {
        return t('Not found. The job will be imported disabled; fix this source ' +
            'before enabling it.');
    }
    if (source.remote)
        return t('Remote source. SaveMe cannot check it automatically.');
    return t('Could not check this folder.');
}

export const RecoveryImportDialog = GObject.registerClass({
    GTypeName: 'SaveMeRecoveryImportDialog',
}, class RecoveryImportDialog extends Adw.Window {
    constructor(parentWindow, recoverDialog, entry, result, {allowRestore = true} = {}) {
        super({
            transient_for: recoverDialog,
            modal: true,
            title: t('Import job'),
            default_width: 820,
            default_height: 700,
        });
        this.parentWindow = parentWindow;
        this.recoverDialog = recoverDialog;
        this.entry = entry;
        this.result = result;
        this.allowRestore = allowRestore;
        this._busy = false;
        this._build();
    }

    _build() {
        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        header.set_title_widget(new Adw.WindowTitle({
            title: t('Import job'),
            subtitle: this.entry.job.name || this.entry.id,
        }));
        const cancel = new Gtk.Button({label: t('Cancel')});
        cancel.connect('clicked', () => this.close());
        header.pack_start(cancel);
        toolbar.add_top_bar(header);

        const page = new Adw.PreferencesPage();
        const destination = destinationDisplay(this.result.destination);
        const summary = new Adw.PreferencesGroup({title: t('Job')});
        summary.add(new Adw.ActionRow({
            title: this.entry.job.name || this.entry.id,
            subtitle: `${this.entry.job.type === 'backup' ? t('Backup') : t('Sync')} · ` +
                `${this.entry.id}`,
        }));
        summary.add(new Adw.ActionRow({
            title: t('Destination base'),
            subtitle: destination || t('Not selected'),
        }));
        if (destination) {
            summary.add(new Adw.ActionRow({
                title: t('Job folder'),
                subtitle: joinPath(destination, `SaveMe/${this.entry.id}`),
            }));
        }
        page.add(summary);

        this.sourceGroup = new Adw.PreferencesGroup({title: t('Sources')});
        page.add(this.sourceGroup);
        this._renderSources();

        const actions = new Adw.PreferencesGroup({
            title: t('Choose an action'),
            description: t('Both options recreate the job configuration. Neither option ' +
                'writes to the source folder.'),
        });
        actions.add(new Adw.ActionRow({
            title: t('Import job only'),
            subtitle: t('Recreates the job settings and imports the job disabled and manual. ' +
                'It does not copy, move, delete or modify any file in the source folder or ' +
                'in SaveMe.'),
        }));
        if (this.allowRestore && this.entry.job.type === 'backup') {
            actions.add(new Adw.ActionRow({
                title: t('Import and restore'),
                subtitle: t('Recreates the job, then opens Restore. Restore copies files from ' +
                    'the SaveMe backup to a target folder you choose. It never writes to the ' +
                    'original source folder; the source stays exactly as it is.'),
            }));
        }
        this.enableRow = new Adw.SwitchRow({
            title: t('Enable job after importing'),
            subtitle: t('Imported jobs stay disabled and manual until you confirm ' +
                'the sources and press Play.'),
            active: false,
        });
        actions.add(this.enableRow);
        this._updateEnableRow();
        page.add(actions);

        const existing = (this.parentWindow.snapshot?.jobs || [])
            .some(item => item.id === this.entry.id);
        if (existing) {
            const warning = new Adw.PreferencesGroup({title: t('Attention')});
            warning.add(new Adw.ActionRow({
                title: t('A job with this ID already exists'),
                subtitle: t('Importing replaces its configuration. Backup data is not deleted.'),
            }));
            page.add(warning);
        }

        const scrolled = new Gtk.ScrolledWindow({
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
        });
        scrolled.set_child(page);
        toolbar.set_content(scrolled);

        this.actionBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 12,
            margin_end: 12,
            halign: Gtk.Align.END,
        });
        const cancelButton = new Gtk.Button({label: t('Cancel')});
        cancelButton.connect('clicked', () => this.close());
        this.actionBox.append(cancelButton);
        this.importButton = new Gtk.Button({label: t('Import job')});
        this.importButton.connect('clicked', () => this._import(false));
        this.actionBox.append(this.importButton);
        if (this.allowRestore && this.entry.job.type === 'backup') {
            this.restoreButton = new Gtk.Button({
                label: t('Import and restore'),
                css_classes: ['suggested-action'],
            });
            this.restoreButton.connect('clicked', () => this._import(true));
            this.actionBox.append(this.restoreButton);
        }
        toolbar.add_bottom_bar(this.actionBox);
        this.set_content(toolbar);
    }

    _renderSources() {
        for (const row of this.sourceRows || [])
            this.sourceGroup.remove(row);
        this.sourceRows = [];
        const sources = this.entry.sources || [];
        if (sources.length === 0) {
            const row = new Adw.ActionRow({
                title: t('No sources in the manifest'),
                subtitle: t('The job will be imported disabled; choose the source in the editor.'),
            });
            this.sourceGroup.add(row);
            this.sourceRows.push(row);
        }
        for (const [index, source] of sources.entries()) {
            const row = new Adw.ActionRow({
                title: source.path || t('Unknown source'),
                subtitle: sourceDescription(source),
            });
            row.add_prefix(new Gtk.Image({
                icon_name: sourceIcon(source),
                pixel_size: 18,
            }));
            if (!source.remote) {
                const change = new Gtk.Button({
                    label: t('Change'),
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                change.connect('clicked', () => this._chooseSource(index));
                row.add_suffix(change);
            }
            this.sourceGroup.add(row);
            this.sourceRows.push(row);
        }
        this._updateEnableRow();
    }

    _chooseSource(index) {
        const dialog = new Gtk.FileDialog({
            title: t('Choose source folder'),
            modal: true,
        });
        dialog.select_folder(this, null, (source, result) => {
            try {
                const path = source.select_folder_finish(result).get_path();
                if (!path)
                    return;
                const descriptor = this.parentWindow.volumes?.makeDescriptor
                    ? this.parentWindow.volumes.makeDescriptor(path)
                    : {kind: 'local', path};
                this.entry.sources[index] = {
                    kind: 'local',
                    path,
                    exists: true,
                    remote: false,
                };
                const jobSources = Array.isArray(this.entry.job.sources)
                    ? [...this.entry.job.sources]
                    : [];
                jobSources[index] = descriptor;
                this.entry.job.sources = jobSources;
                if (index === 0)
                    this.entry.job.source = descriptor;
                this._renderSources();
            } catch (_) {
                // Dialog dismissed.
            }
        });
    }

    _updateEnableRow() {
        if (!this.enableRow)
            return;
        const sources = this.entry.sources || [];
        const available = sources.length > 0 &&
            sources.every(source => source.exists !== false);
        this.enableRow.sensitive = available;
        this.enableRow.subtitle = available
            ? t('Imported jobs stay disabled and manual until you confirm ' +
                'the sources and press Play.')
            : t('Fix the missing sources before enabling the job.');
        if (!available)
            this.enableRow.active = false;
    }

    _setBusy(busy) {
        this._busy = busy;
        for (const button of [this.importButton, this.restoreButton])
            button && (button.sensitive = !busy);
    }

    async _import(restore) {
        if (this._busy)
            return;
        this._setBusy(true);
        try {
            const job = JSON.parse(JSON.stringify(this.entry.job));
            job.id = this.entry.id;
            if (this.result.destination)
                job.destination = this.result.destination;
            job.destinationLayout = 'saveMe';
            const saved = await this.parentWindow.client.importJob(job);
            const enable = Boolean(this.enableRow?.active);
            if (enable)
                await this.parentWindow.client.setJobEnabled(saved.id, true);
            await this.parentWindow.refresh();
            if (restore && saved.type === 'backup')
                new RestoreDialog(this.parentWindow, saved).present();
            else
                this.parentWindow.toast(enable
                    ? t('Job imported and enabled.')
                    : t('Job imported. Review the sources before enabling it.'));
            this.close();
            this.recoverDialog?.close();
        } catch (e) {
            const dialog = new Adw.AlertDialog({
                heading: t('Cannot import backup'),
                body: e.message,
            });
            dialog.add_response('ok', t('OK'));
            dialog.present(this);
        } finally {
            this._setBusy(false);
        }
    }
});
