import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {RemoteBrowserDialog} from './remote-browser.js';
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

export const RecoverySyncDialog = GObject.registerClass({
    GTypeName: 'SaveMeRecoverySyncDialog',
}, class RecoverySyncDialog extends Adw.Window {
    constructor(parentWindow, recoverDialog, entry, result) {
        super({
            transient_for: recoverDialog,
            modal: true,
            title: t('Recreate sync job'),
            default_width: 780,
            default_height: 680,
        });
        this.parentWindow = parentWindow;
        this.recoverDialog = recoverDialog;
        this.entry = entry;
        this.result = result;
        this.source = null;
        this._busy = false;
        this._build();
    }

    _build() {
        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        header.set_title_widget(new Adw.WindowTitle({
            title: t('Recreate sync job'),
            subtitle: this.entry.id,
        }));
        const cancel = new Gtk.Button({label: t('Cancel')});
        cancel.connect('clicked', () => this.close());
        header.pack_start(cancel);
        toolbar.add_top_bar(header);

        const page = new Adw.PreferencesPage();
        const why = new Adw.PreferencesGroup({
            title: t('Why recreate this job?'),
            description: t('This folder was created by a sync job from an older SaveMe ' +
                'version, so it has no manifest. The original source, filters and schedule ' +
                'cannot be recovered automatically.'),
        });
        page.add(why);

        const what = new Adw.PreferencesGroup({
            title: t('What SaveMe will do'),
            description: t('Create a sync job with the same ID, using the source folder you ' +
                'choose and the existing destination folder. No files in the backup are ' +
                'copied, moved or deleted.'),
        });
        what.add(new Adw.ActionRow({
            title: t('Job ID'),
            subtitle: this.entry.id,
        }));
        const destination = destinationDisplay(this.result.destination);
        what.add(new Adw.ActionRow({
            title: t('Destination base'),
            subtitle: destination || t('Not selected'),
        }));
        if (destination) {
            what.add(new Adw.ActionRow({
                title: t('Current folder'),
                subtitle: joinPath(destination, `SaveMe/${this.entry.id}/current`),
            }));
        }
        page.add(what);

        const sourceGroup = new Adw.PreferencesGroup({
            title: t('Choose the original source folder'),
            description: t('This is the folder SaveMe should sync from now on. It must be ' +
                'the same folder the old job used, or a replacement with the same content.'),
        });
        this.sourceRow = new Adw.ActionRow({
            title: t('Selected source'),
            subtitle: t('Not selected'),
        });
        sourceGroup.add(this.sourceRow);
        const localRow = new Adw.ActionRow({
            title: t('Local folder'),
            subtitle: t('Choose a folder on this computer.'),
        });
        const localButton = new Gtk.Button({
            label: t('Choose'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        localButton.connect('clicked', () => this._chooseLocal());
        localRow.add_suffix(localButton);
        sourceGroup.add(localRow);
        const remoteRow = new Adw.ActionRow({
            title: t('Cloud remote'),
            subtitle: t('Choose a folder from a configured cloud account.'),
        });
        const remoteButton = new Gtk.Button({
            label: t('Choose'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        remoteButton.connect('clicked', () => this._chooseRemote());
        remoteRow.add_suffix(remoteButton);
        sourceGroup.add(remoteRow);
        page.add(sourceGroup);

        const note = new Adw.PreferencesGroup({title: t('Before enabling')});
        note.add(new Adw.ActionRow({
            title: t('The job is imported disabled'),
            subtitle: t('Review the source, filters and schedule before enabling it. ' +
                'The first sync may compare the source with the existing backup.'),
        }));
        page.add(note);

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
        this.recreateButton = new Gtk.Button({
            label: t('Recreate job'),
            css_classes: ['suggested-action'],
            sensitive: false,
        });
        this.recreateButton.connect('clicked', () => this._recreate());
        this.actionBox.append(this.recreateButton);
        toolbar.add_bottom_bar(this.actionBox);
        this.set_content(toolbar);
    }

    _chooseLocal() {
        const dialog = new Gtk.FileDialog({
            title: t('Choose source folder'),
            modal: true,
        });
        dialog.select_folder(this, null, (source, result) => {
            try {
                const path = source.select_folder_finish(result).get_path();
                if (path)
                    this._setSource({kind: 'local', path});
            } catch (_) {
                // Dialog dismissed.
            }
        });
    }

    _chooseRemote() {
        new RemoteBrowserDialog(this.parentWindow, {
            mode: 'pick',
            transientFor: this,
            onSelect: descriptor => this._setSource(descriptor),
        }).present();
    }

    _setSource(descriptor) {
        this.source = descriptor;
        this.sourceRow.set_subtitle(destinationDisplay(descriptor));
        this.recreateButton.sensitive = true;
    }

    async _recreate() {
        if (!this.source || this._busy)
            return;
        this._busy = true;
        this.recreateButton.sensitive = false;
        try {
            const saved = await this.parentWindow.client.importJob({
                id: this.entry.id,
                name: this.entry.id,
                type: 'sync',
                source: this.source,
                sources: [this.source],
                destination: this.result.destination,
                destinationLayout: 'saveMe',
                trigger: {mode: 'manual'},
                recovered: true,
                enabled: false,
                filters: {exclude: [], include: []},
            });
            await this.parentWindow.refresh();
            this.parentWindow.toast(
                t('Sync job recreated. Review the settings before enabling it.'));
            this.close();
            this.recoverDialog?.close();
            return saved;
        } catch (e) {
            const dialog = new Adw.AlertDialog({
                heading: t('Cannot recreate sync job'),
                body: e.message,
            });
            dialog.add_response('ok', t('OK'));
            dialog.present(this);
            return null;
        } finally {
            this._busy = false;
            if (this.source)
                this.recreateButton.sensitive = true;
        }
    }
});
