import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {t} from '../../src/i18n.js';
import {remoteTypeLabel} from '../presentation/format.js';
import {iconButton} from '../widgets/common.js';

export class AccountsPage {
    constructor(window) {
        this.window = window;
        this.widget = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        this.page = new Adw.PreferencesPage({vexpand: true});
        this.widget.append(this.page);
        this.addButton = new Gtk.Button({
            label: t('Add account'),
            icon_name: 'list-add-symbolic',
            hexpand: true,
            margin_top: 4,
            margin_bottom: 12,
            css_classes: ['suggested-action'],
        });
        this.addButton.connect('clicked', () => this.window.addAccount(null));
        const addBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            margin_start: 12,
            margin_end: 12,
        });
        addBox.append(new Adw.Clamp({
            maximum_size: 600,
            tightening_threshold: 500,
            hexpand: true,
            child: this.addButton,
        }));
        this.widget.append(addBox);
        this.group = null;
        this.key = null;
    }

    update(snapshot) {
        const remotes = snapshot.remotes || [];
        const key = remotes.map(remote =>
            `${remote.name}:${remote.type}:${remote.label}:${remote.options?.drive_type || ''}`)
            .join('|');
        if (key === this.key)
            return;
        this.key = key;
        this._rebuild(remotes);
    }

    _rebuild(remotes) {
        if (this.group)
            this.page.remove(this.group);
        this.group = new Adw.PreferencesGroup({
            title: t('Accounts'),
            description: t('Cloud accounts used by sync and backup jobs.'),
        });
        if (remotes.length === 0) {
            const row = new Adw.ActionRow({
                title: t('No accounts configured'),
                subtitle: t('Add Google Drive, OneDrive or Dropbox.'),
            });
            this.group.add(row);
        } else {
            for (const remote of remotes) {
                const row = new Adw.ActionRow({
                    title: remote.label || remote.name,
                    subtitle: `${remoteTypeLabel(remote.type)} · ${remote.name}`,
                });
                row.add_prefix(new Gtk.Image({
                    icon_name: 'folder-remote-symbolic',
                    pixel_size: 16,
                }));
                const reauth = iconButton('view-refresh-symbolic', t('Reconnect'), {
                    cssClasses: ['flat'],
                });
                reauth.connect('clicked', () => this.window.addAccount(remote));
                const remove = iconButton('edit-delete-symbolic', t('Delete'), {
                    cssClasses: ['flat', 'destructive-action'],
                });
                remove.connect('clicked', () => {
                    this.window.confirm(t('Delete account?'),
                        `${t('Delete')} ${remote.name}? ` +
                        t('Jobs using it must be removed or edited first.'),
                        true, () => {
                            this.window.client.deleteRemote(remote.name)
                                .then(() => this.window.toast(t('Account deleted.')))
                                .catch(e => this._showError(
                                    t('Cannot delete account'), e.message));
                        });
                });
                row.add_suffix(reauth);
                row.add_suffix(remove);
                this.group.add(row);
            }
        }
        this.page.add(this.group);
    }

    _showError(title, message) {
        const dialog = new Adw.AlertDialog({heading: title, body: message});
        dialog.add_response('ok', 'OK');
        dialog.present(this.window);
    }
}
