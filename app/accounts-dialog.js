import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {AccountDialog} from './account-dialog.js';
import {remoteTypeLabel} from './presentation/format.js';

const PROVIDER_LABELS = {
    drive: 'Google Drive',
    onedrive: 'Microsoft OneDrive',
    dropbox: 'Dropbox',
    nextcloud: 'Nextcloud',
    s3: 'S3 compatible',
    pcloud: 'pCloud',
};

/**
 * Manage cloud accounts without leaving the job wizard. Accounts can be
 * reconnected or deleted here, which is the recovery path for a broken
 * remote that prevents the folder browser from opening.
 */
export const AccountsDialog = GObject.registerClass({
    GTypeName: 'SaveMeAccountsDialog',
}, class AccountsDialog extends Adw.Window {
    constructor(parentWindow, {
        provider = null,
        transientFor = null,
        onUse = null,
        onDone = null,
        onDeleted = null,
        title = null,
    } = {}) {
        super({
            transient_for: transientFor || parentWindow,
            modal: true,
            title: title || 'Cloud accounts',
            default_width: 680,
            default_height: 560,
        });
        this.window = parentWindow;
        this.client = parentWindow.client;
        this.provider = provider;
        this.onUse = onUse;
        this.onDone = onDone;
        this.onDeleted = onDeleted;
        this._build();
    }

    _build() {
        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        const title = this.provider
            ? `${PROVIDER_LABELS[this.provider] || 'Cloud'} accounts`
            : 'Cloud accounts';
        header.set_title_widget(new Adw.WindowTitle({title}));
        const close = new Gtk.Button({label: 'Close'});
        close.connect('clicked', () => this.close());
        header.pack_start(close);
        this.addButton = new Gtk.Button({
            label: 'Add account',
            css_classes: ['suggested-action'],
        });
        this.addButton.connect('clicked', () => this._addAccount());
        header.pack_end(this.addButton);
        toolbar.add_top_bar(header);

        this.page = new Adw.PreferencesPage();
        toolbar.set_content(this.page);
        this.set_content(toolbar);
        this.reload();
    }

    reload() {
        if (this.group)
            this.page.remove(this.group);
        this.group = new Adw.PreferencesGroup({
            title: this.provider
                ? `${PROVIDER_LABELS[this.provider] || 'Cloud'} accounts`
                : 'Accounts',
            description: this.provider
                ? 'Reconnect a broken account or delete the one that no longer works.'
                : 'Accounts used by sync and backup jobs.',
        });
        this.remotes = (this.window.snapshot?.remotes || [])
            .filter(remote => !this.provider || remote.type === this.provider);
        if (this.remotes.length === 0) {
            const empty = new Adw.ActionRow({
                title: 'No accounts configured',
                subtitle: this.provider
                    ? `Connect a ${PROVIDER_LABELS[this.provider] || 'cloud'} account.`
                    : 'Connect Google Drive, OneDrive or Dropbox.',
            });
            const button = new Gtk.Button({
                label: 'Connect',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            button.connect('clicked', () => this._addAccount());
            empty.add_suffix(button);
            this.group.add(empty);
        } else {
            for (const remote of this.remotes)
                this.group.add(this._remoteRow(remote));
        }
        if (this.provider) {
            this.addButton.visible = false;
            const addRow = new Adw.ActionRow({
                title: 'Connect another account',
                subtitle: `Add a second ${PROVIDER_LABELS[this.provider] || 'cloud'} account.`,
            });
            const add = new Gtk.Button({
                label: 'Add',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            add.connect('clicked', () => this._addAccount());
            addRow.add_suffix(add);
            this.group.add(addRow);
        } else if (this.remotes.length > 0) {
            const addRow = new Adw.ActionRow({
                title: 'Connect another account',
                subtitle: 'Add Google Drive, OneDrive or Dropbox.',
            });
            const add = new Gtk.Button({
                label: 'Add',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            add.connect('clicked', () => this._addAccount());
            addRow.add_suffix(add);
            this.group.add(addRow);
        }
        this.page.add(this.group);
    }

    _remoteRow(remote) {
        const driveType = remote.options?.drive_type
            ? ` · ${remote.options.drive_type === 'business' ? 'Business' : 'Personal'}`
            : '';
        const row = new Adw.ActionRow({
            title: remote.label || remote.name,
            subtitle: `${remoteTypeLabel(remote.type)}${driveType} · ${remote.name}`,
        });
        row.add_prefix(new Gtk.Image({
            icon_name: 'folder-remote-symbolic',
            pixel_size: 16,
        }));
        if (this.onUse) {
            const use = new Gtk.Button({
                label: 'Use',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat', 'suggested-action'],
            });
            use.connect('clicked', () => {
                this.onUse?.(remote);
                this.close();
            });
            row.add_suffix(use);
        }
        const reconnect = new Gtk.Button({
            label: 'Reconnect',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        reconnect.connect('clicked', () => this._reconnect(remote));
        const remove = new Gtk.Button({
            label: 'Delete',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat', 'destructive-action'],
        });
        remove.connect('clicked', () => this._delete(remote));
        row.add_suffix(reconnect);
        row.add_suffix(remove);
        return row;
    }

    _addAccount() {
        if (!this.provider) {
            const dialog = new Adw.AlertDialog({
                heading: 'Add account',
                body: 'Choose the provider for the new account.',
            });
            dialog.add_response('cancel', 'Cancel');
            dialog.add_response('drive', 'Google Drive');
            dialog.add_response('onedrive', 'Microsoft OneDrive');
            dialog.add_response('dropbox', 'Dropbox');
            dialog.add_response('nextcloud', 'Nextcloud');
            dialog.add_response('s3', 'S3 compatible');
            dialog.add_response('pcloud', 'pCloud');
            dialog.set_response_appearance('drive', Adw.ResponseAppearance.SUGGESTED);
            dialog.connect('response', (_dialog, response) => {
                if (['drive', 'onedrive', 'dropbox', 'nextcloud', 's3', 'pcloud']
                    .includes(response))
                    this._openAddDialog(response);
            });
            dialog.present(this);
            return;
        }
        this._openAddDialog(this.provider);
    }

    _openAddDialog(provider) {
        new AccountDialog(this.window, null, {
            provider,
            transientFor: this,
            onDone: () => this._refresh(),
        }).present();
    }

    _reconnect(remote) {
        new AccountDialog(this.window, remote, {
            transientFor: this,
            onDone: () => {
                const stillExists = (this.window.snapshot?.remotes || [])
                    .some(item => item.name === remote.name);
                if (!stillExists)
                    this.onDeleted?.(remote.name);
                this._refresh();
            },
        }).present();
    }

    _delete(remote) {
        const dialog = new Adw.AlertDialog({
            heading: 'Delete account?',
            body: `Delete ${remote.name}? Jobs that use this account must be edited first. ` +
                'Draft jobs do not block deletion.',
        });
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('delete', 'Delete');
        dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.connect('response', (_dialog, response) => {
            if (response === 'delete')
                this._deleteConfirmed(remote);
        });
        dialog.present(this);
    }

    async _deleteConfirmed(remote) {
        try {
            await this.client.deleteRemote(remote.name);
            this.window.toast('Account deleted.');
            this.onDeleted?.(remote.name);
            await this.window.refresh();
            this.reload();
            this.onDone?.();
        } catch (e) {
            this._showError('Cannot delete account', e.message);
        }
    }

    async _refresh() {
        await this.window.refresh();
        this.reload();
        this.onDone?.();
    }

    _showError(title, message) {
        const dialog = new Adw.AlertDialog({heading: title, body: message});
        dialog.add_response('ok', 'OK');
        dialog.present(this);
    }
});
