import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {AccountDialog} from './account-dialog.js';
import {AccountsDialog} from './accounts-dialog.js';

function formatBytes(value) {
    let n = Number(value) || 0;
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let unit = 0;
    while (n >= 1024 && unit < units.length - 1) {
        n /= 1024;
        unit++;
    }
    return `${n.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export const RemoteBrowserDialog = GObject.registerClass({
    GTypeName: 'SaveMeRemoteBrowserDialog',
}, class RemoteBrowserDialog extends Adw.Window {
    constructor(mainWindow, {
        mode = 'browse',
        remote = null,
        path = '',
        jobId = null,
        version = '',
        remoteType = null,
        transientFor = null,
        onSelect = null,
    } = {}) {
        super({
            transient_for: transientFor || mainWindow,
            modal: true,
            title: jobId ? 'Browse backup'
                : mode === 'pick' ? 'Choose cloud folder' : 'Browse cloud folder',
            default_width: 760,
            default_height: 620,
        });
        this.mainWindow = mainWindow;
        this.client = mainWindow.client;
        this.mode = mode;
        this.onSelect = onSelect;
        this.remote = remote;
        this.path = String(path || '').replace(/^\/+|\/+$/g, '');
        this.jobId = jobId;
        this.version = version || '';
        this.remoteType = remoteType;
        this.backupMode = Boolean(jobId);
        this.remotes = [];
        this.loadToken = 0;
        this._updating = false;
        this._build();
        if (this.backupMode)
            this.updateRemotes();
        else
            this.updateRemotes();
    }

    _build() {
        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        header.set_title_widget(new Adw.WindowTitle({title: this.title}));
        const close = new Gtk.Button({label: 'Close'});
        close.connect('clicked', () => this.close());
        header.pack_start(close);
        if (this.mode === 'pick') {
            this.selectButton = new Gtk.Button({
                label: this.backupMode ? 'Select' : 'Select this folder',
                css_classes: ['suggested-action'],
            });
            this.selectButton.connect('clicked', () => this._select());
            header.pack_end(this.selectButton);
        } else {
            const copy = new Gtk.Button({
                label: 'Copy path',
                css_classes: ['flat'],
            });
            copy.connect('clicked', () => this._copyPath());
            header.pack_end(copy);
        }
        toolbar.add_top_bar(header);

        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });

        this.controls = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
        });
        if (this.backupMode) {
            this.controls.append(new Gtk.Label({
                label: this.version ? `Version ${this.version}` : 'Current backup',
                css_classes: ['dim-label'],
            }));
        }
        this.remoteDropDown = new Gtk.DropDown({
            hexpand: true,
            model: Gtk.StringList.new(['No accounts']),
            visible: !this.backupMode,
        });
        this.remoteDropDown.connect('notify::selected', () => {
            if (this._updating || this.remotes.length === 0)
                return;
            const remote = this.remotes[this.remoteDropDown.selected];
            if (!remote)
                return;
            this.remote = remote.name;
            this.path = '';
            this._load();
        });
        this.pathEntry = new Gtk.Entry({
            hexpand: true,
            placeholder_text: 'folder/path',
        });
        this.pathEntry.connect('activate', () => this._go(this.pathEntry.text));
        const goButton = new Gtk.Button({label: 'Go'});
        goButton.connect('clicked', () => this._go(this.pathEntry.text));
        this.manageButton = new Gtk.Button({
            label: 'Manage accounts',
            tooltip_text: 'Add, reconnect or delete cloud accounts',
            visible: !this.backupMode,
        });
        this.manageButton.connect('clicked', () => this._manageAccounts());
        this.controls.append(this.remoteDropDown);
        this.controls.append(this.pathEntry);
        this.controls.append(goButton);
        this.controls.append(this.manageButton);
        content.append(this.controls);

        this.emptyBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            visible: false,
            margin_top: 12,
            margin_bottom: 12,
        });
        const emptyLabel = new Gtk.Label({
            label: 'No cloud accounts configured.',
            xalign: 0,
        });
        const addAccount = new Gtk.Button({
            label: 'Add account',
            halign: Gtk.Align.START,
            css_classes: ['suggested-action'],
        });
        addAccount.connect('clicked', () => this._addAccount());
        const manage = new Gtk.Button({
            label: 'Manage accounts',
            halign: Gtk.Align.START,
            css_classes: ['flat'],
        });
        manage.connect('clicked', () => this._manageAccounts());
        this.emptyBox.append(emptyLabel);
        this.emptyBox.append(addAccount);
        this.emptyBox.append(manage);
        content.append(this.emptyBox);

        this.breadcrumb = new Gtk.Label({
            xalign: 0,
            selectable: true,
            wrap: true,
            css_classes: ['dim-label'],
        });
        content.append(this.breadcrumb);

        this.listBox = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            activate_on_single_click: true,
            show_separators: true,
        });
        this.listBox.connect('row-activated', (_box, row) => this._activateRow(row));
        const scrolled = new Gtk.ScrolledWindow({vexpand: true, hexpand: true});
        scrolled.set_child(this.listBox);
        content.append(scrolled);

        this.statusLabel = new Gtk.Label({
            xalign: 0,
            wrap: true,
            visible: false,
            css_classes: ['error'],
        });
        content.append(this.statusLabel);

        toolbar.set_content(content);
        this.set_content(toolbar);
    }

    updateRemotes() {
        if (this.backupMode) {
            this.remotes = [];
            this.remote = 'backup';
            this.controls.visible = true;
            this.emptyBox.visible = false;
            this.breadcrumb.visible = true;
            this._load();
            return;
        }
        this.remotes = this.mainWindow.snapshot?.remotes || [];
        if (this.remoteType)
            this.remotes = this.remotes.filter(remote => remote.type === this.remoteType);
        const labels = this.remotes.map(remote => remote.label || remote.name);
        this._updating = true;
        this.remoteDropDown.model = Gtk.StringList.new(
            labels.length ? labels : ['No accounts']);
        let index = this.remote
            ? this.remotes.findIndex(remote => remote.name === this.remote)
            : 0;
        if (index < 0)
            index = 0;
        this.remoteDropDown.selected = index;
        this.remoteDropDown.sensitive = this.remotes.length > 0;
        this._updating = false;

        if (this.remotes.length === 0) {
            this.remote = null;
            this.controls.visible = false;
            this.emptyBox.visible = true;
            this.breadcrumb.visible = false;
            this._clearList();
            return;
        }
        this.emptyBox.visible = false;
        this.controls.visible = true;
        this.breadcrumb.visible = true;
        this.remote = this.remotes[index].name;
        this._load();
    }

    _clearList() {
        let child = this.listBox.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this.listBox.remove(child);
            child = next;
        }
    }

    _setStatus(message) {
        this.statusLabel.set_text(message || '');
        this.statusLabel.visible = Boolean(message);
    }

    async _load() {
        if (!this.remote)
            return;
        const token = ++this.loadToken;
        this._clearList();
        this._setStatus('Loading…');
        this.pathEntry.text = this.path;
        if (this.backupMode) {
            this.breadcrumb.set_text(
                `${this.version ? `version ${this.version}` : 'current backup'}: /${this.path}`);
        } else {
            this.breadcrumb.set_text(
                `${this.remote}:${this.path ? `/${this.path}` : '/'}`);
        }
        try {
            const entries = this.backupMode
                ? await this.client.listBackup(this.jobId, this.version, this.path, false)
                : await this.client.listRemote(this.remote, this.path, this.mode === 'pick');
            if (token !== this.loadToken)
                return;
            this._setStatus('');
            this._render(entries);
        } catch (e) {
            if (token === this.loadToken) {
                const hint = this.backupMode
                    ? ''
                    : '\nUse “Manage accounts” to reconnect or delete a broken account.';
                this._setStatus(`${e.message}${hint}`);
            }
        }
    }

    _render(entries) {
        if (this.path) {
            this._addRow({
                name: '..',
                isDir: true,
                size: 0,
                up: true,
            });
        }
        const list = entries || [];
        if (list.length === 0) {
            this._addInfoRow(this.mode === 'pick'
                ? 'No subfolders here. You can type a folder path above.'
                : 'This folder is empty.');
            return;
        }
        for (const entry of list) {
            this._addRow({
                name: entry.name,
                isDir: entry.isDir,
                size: entry.size,
                up: false,
            });
        }
    }

    _addInfoRow(text) {
        const row = new Gtk.ListBoxRow({activatable: false, selectable: false});
        row.set_child(new Gtk.Label({
            label: text,
            xalign: 0,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 8,
            margin_end: 8,
            wrap: true,
            css_classes: ['dim-label'],
        }));
        this.listBox.append(row);
    }

    _addRow({name, isDir, size, up}) {
        const row = new Gtk.ListBoxRow({activatable: true});
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 10,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 8,
            margin_end: 8,
        });
        const icon = new Gtk.Image({
            icon_name: up ? 'go-up-symbolic'
                : isDir ? 'folder-symbolic' : 'text-x-generic-symbolic',
        });
        box.append(icon);
        box.append(new Gtk.Label({
            label: name,
            xalign: 0,
            hexpand: true,
            ellipsize: Pango.EllipsizeMode.END,
        }));
        if (isDir && !up)
            box.append(new Gtk.Image({icon_name: 'go-next-symbolic'}));
        else if (!isDir)
            box.append(new Gtk.Label({
                label: formatBytes(size),
                css_classes: ['dim-label'],
            }));
        row.set_child(box);
        row._saveMeEntry = {name, isDir, up};
        this.listBox.append(row);
    }

    _activateRow(row) {
        const entry = row._saveMeEntry;
        if (!entry)
            return;
        if (entry.up) {
            const parts = this.path.split('/').filter(Boolean);
            parts.pop();
            this._go(parts.join('/'));
        } else if (entry.isDir) {
            this._go(this.path ? `${this.path}/${entry.name}` : entry.name);
        } else if (this.backupMode) {
            this.path = this.path ? `${this.path}/${entry.name}` : entry.name;
            this._select();
        }
    }

    _go(path) {
        this.path = String(path || '').replace(/^\/+|\/+$/g, '');
        this._load();
    }

    _select() {
        if (this.backupMode) {
            this.path = String(this.pathEntry.text || this.path || '')
                .replace(/^\/+|\/+$/g, '');
            this.onSelect?.({path: this.path});
            this.close();
            return;
        }
        if (!this.remote) {
            this._setStatus('Choose a cloud account first.');
            return;
        }
        this.path = String(this.pathEntry.text || this.path || '')
            .replace(/^\/+|\/+$/g, '');
        this.onSelect?.({
            kind: 'remote',
            remote: this.remote,
            path: this.path,
        });
        this.close();
    }

    _copyPath() {
        const text = this.backupMode
            ? this.path
            : `${this.remote || ''}:${this.path ? `/${this.path}` : '/'}`;
        try {
            this.get_clipboard().set(text);
            this.mainWindow.toast('Path copied.');
        } catch (e) {
            this.mainWindow.toast(e.message);
        }
    }

    _addAccount() {
        new AccountDialog(this.mainWindow, null, {
            provider: this.remoteType,
            transientFor: this,
            onDone: () => {
                this.remotes = this.mainWindow.snapshot?.remotes || [];
                this.updateRemotes();
            },
        }).present();
    }

    _manageAccounts() {
        new AccountsDialog(this.mainWindow, {
            provider: this.remoteType,
            transientFor: this,
            onDeleted: name => {
                if (this.remote === name)
                    this.remote = null;
            },
            onDone: () => this.updateRemotes(),
        }).present();
    }
});
