import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {remoteTypeLabel} from '../presentation/format.js';

export class AccountsPage {
    constructor(window) {
        this.window = window;
        this.widget = new Adw.PreferencesPage();
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
            this.widget.remove(this.group);
        this.group = new Adw.PreferencesGroup({
            title: 'Accounts',
            description: 'Cloud accounts used by sync and backup jobs.',
        });
        if (remotes.length === 0) {
            const row = new Adw.ActionRow({
                title: 'No accounts configured',
                subtitle: 'Add Google Drive, OneDrive or Dropbox.',
            });
            const button = new Gtk.Button({
                label: 'Add account',
                valign: Gtk.Align.CENTER,
                css_classes: ['suggested-action'],
            });
            button.connect('clicked', () => this.window.addAccount(null));
            row.add_suffix(button);
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
                const menu = new Gtk.MenuButton({
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                menu.set_child(new Gtk.Image({icon_name: 'view-more-symbolic'}));
                const popover = new Gtk.Popover();
                const box = new Gtk.Box({
                    orientation: Gtk.Orientation.VERTICAL,
                    spacing: 2,
                    margin_top: 6,
                    margin_bottom: 6,
                    margin_start: 6,
                    margin_end: 6,
                });
                const reauth = new Gtk.Button({label: 'Reauthenticate', css_classes: ['flat']});
                reauth.connect('clicked', () => {
                    popover.popdown();
                    this.window.addAccount(remote);
                });
                const remove = new Gtk.Button({
                    label: 'Delete',
                    css_classes: ['flat', 'destructive-action'],
                });
                remove.connect('clicked', () => {
                    popover.popdown();
                    this.window.confirm('Delete account?',
                        `Delete ${remote.name}? Jobs using it must be removed or edited first.`,
                        true, () => {
                            this.window.client.deleteRemote(remote.name)
                                .then(() => this.window.toast('Account deleted.'))
                                .catch(e => this.window.toast(e.message));
                        });
                });
                box.append(reauth);
                box.append(remove);
                popover.set_child(box);
                menu.set_popover(popover);
                row.add_suffix(menu);
                this.group.add(row);
            }
            const addRow = new Adw.ActionRow({
                title: 'Add account',
                subtitle: 'Connect another cloud account.',
            });
            const addButton = new Gtk.Button({
                label: 'Add',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            addButton.connect('clicked', () => this.window.addAccount(null));
            addRow.add_suffix(addButton);
            this.group.add(addRow);
        }
        this.widget.add(this.group);
    }
}
