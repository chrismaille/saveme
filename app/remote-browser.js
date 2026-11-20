import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {AccountDialog} from './account-dialog.js';
import {AccountsDialog} from './accounts-dialog.js';
import {t} from '../src/i18n.js';
import {
    isValidRemoteFolderName,
    normalizeRemoteFolderName,
} from '../src/domain/remote-folder.js';

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

function cleanPath(path) {
    return String(path || '').replace(/^\/+|\/+$/g, '');
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
            title: jobId ? t('Browse backup')
                : mode === 'pick' ? t('Choose cloud folder') : t('Browse cloud folder'),
            default_width: 760,
            default_height: 620,
        });
        this.mainWindow = mainWindow;
        this.client = mainWindow.client;
        this.mode = mode;
        this.onSelect = onSelect;
        this.remote = remote;
        this.path = cleanPath(path);
        this.selectedPath = this.path;
        this.jobId = jobId;
        this.version = version || '';
        this.remoteType = remoteType;
        this.backupMode = Boolean(jobId);
        this.remotes = [];
        this.nodes = new Map();
        this.expanded = new Set(['']);
        this.rowByPath = new Map();
        this.loadToken = 0;
        this._updating = false;
        this._updatingSelection = false;
        this._build();
        this.updateRemotes();
    }

    _dialogTitle() {
        if (this.backupMode)
            return t('Browse backup');
        return this.mode === 'pick' ? t('Choose cloud folder') : t('Browse cloud folder');
    }

    _build() {
        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        this.titleWidget = new Adw.WindowTitle({title: this._dialogTitle()});
        header.set_title_widget(this.titleWidget);
        const close = new Gtk.Button({label: t('Close')});
        close.connect('clicked', () => this.close());
        header.pack_start(close);
        if (this.mode === 'pick') {
            const actions = new Gtk.Box({spacing: 6});
            if (!this.backupMode) {
                this.newFolderButton = new Gtk.Button({
                    icon_name: 'folder-new-symbolic',
                    tooltip_text: t('New folder'),
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                this.newFolderButton.connect('clicked', () => this._newFolder());
                actions.append(this.newFolderButton);
            }
            this.selectButton = new Gtk.Button({
                label: this.backupMode ? t('Select') : t('Select this folder'),
                css_classes: ['suggested-action'],
            });
            this.selectButton.connect('clicked', () => this._select());
            actions.append(this.selectButton);
            header.pack_end(actions);
        } else {
            const copy = new Gtk.Button({
                label: t('Copy path'),
                css_classes: ['flat'],
            });
            copy.connect('clicked', () => this._copyPath());
            header.pack_end(copy);
        }
        toolbar.add_top_bar(header);

        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 10,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });

        this.accountBar = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
        });
        this.remoteDropDown = new Gtk.DropDown({
            hexpand: true,
            model: Gtk.StringList.new([t('No accounts')]),
        });
        this.remoteDropDown.connect('notify::selected', () => {
            if (this._updating || this.remotes.length === 0)
                return;
            const remote = this.remotes[this.remoteDropDown.selected];
            if (!remote)
                return;
            this.remote = remote.name;
            this.path = '';
            this._openRemote();
        });
        this.manageButton = new Gtk.Button({
            icon_name: 'system-users-symbolic',
            tooltip_text: t('Manage accounts'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        this.manageButton.connect('clicked', () => this._manageAccounts());
        this.accountBar.append(this.remoteDropDown);
        this.accountBar.append(this.manageButton);
        content.append(this.accountBar);

        this.emptyBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            visible: false,
            margin_top: 12,
            margin_bottom: 12,
        });
        this.emptyBox.append(new Gtk.Label({
            label: t('No cloud accounts configured.'),
            xalign: 0,
        }));
        const addAccount = new Gtk.Button({
            label: t('Add account'),
            halign: Gtk.Align.START,
            css_classes: ['suggested-action'],
        });
        addAccount.connect('clicked', () => this._addAccount());
        this.emptyBox.append(addAccount);
        const manage = new Gtk.Button({
            label: t('Manage accounts'),
            halign: Gtk.Align.START,
            css_classes: ['flat'],
        });
        manage.connect('clicked', () => this._manageAccounts());
        this.emptyBox.append(manage);
        content.append(this.emptyBox);

        this.listBox = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.SINGLE,
            activate_on_single_click: false,
            show_separators: false,
            css_classes: ['saveme-folder-tree'],
        });
        this.listBox.connect('row-selected', (_box, row) => {
            if (this._updatingSelection || row?._treePath === undefined)
                return;
            this._setSelected(row._treePath);
        });
        this.listBox.connect('row-activated', (_box, row) => this._activateRow(row));
        this.scrolled = new Gtk.ScrolledWindow({vexpand: true, hexpand: true});
        this.scrolled.set_child(this.listBox);
        content.append(this.scrolled);

        this.selectionBar = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 10,
            visible: false,
            css_classes: ['saveme-selection-bar'],
        });
        this.selectionBar.append(new Gtk.Image({
            icon_name: 'folder-symbolic',
            pixel_size: 18,
            valign: Gtk.Align.CENTER,
        }));
        const selectionText = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 1,
            hexpand: true,
        });
        this.selectionCaption = new Gtk.Label({
            label: t('Selected folder'),
            xalign: 0,
            css_classes: ['caption', 'dim-label'],
        });
        this.selectionLabel = new Gtk.Label({
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.MIDDLE,
            css_classes: ['saveme-selection-path'],
        });
        selectionText.append(this.selectionCaption);
        selectionText.append(this.selectionLabel);
        this.selectionBar.append(selectionText);
        content.append(this.selectionBar);

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
            this.accountBar.visible = false;
            this.emptyBox.visible = false;
            this.selectionBar.visible = true;
            this.titleWidget.set_subtitle(this.version
                ? `${t('Version')} ${this.version}`
                : t('Current backup'));
            this._openRemote();
            return;
        }

        this.remotes = this.mainWindow.snapshot?.remotes || [];
        if (this.remoteType)
            this.remotes = this.remotes.filter(remote => remote.type === this.remoteType);
        const labels = this.remotes.map(remote => remote.label || remote.name);
        this._updating = true;
        this.remoteDropDown.model = Gtk.StringList.new(
            labels.length ? labels : [t('No accounts')]);
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
            this.accountBar.visible = false;
            this.emptyBox.visible = true;
            this.selectionBar.visible = false;
            this._clearList();
            this._updateSelectButton();
            return;
        }
        this.emptyBox.visible = false;
        this.accountBar.visible = true;
        this.selectionBar.visible = true;
        this.remote = this.remotes[index].name;
        this._openRemote();
    }

    _rootLabel() {
        if (this.backupMode) {
            return this.version
                ? `${t('Version')} ${this.version}`
                : t('Current backup');
        }
        return this._remoteLabel();
    }

    _remoteLabel() {
        const remote = this.remotes.find(item => item.name === this.remote);
        return remote?.label || remote?.name || this.remote || '';
    }

    _pathDisplay(path) {
        const clean = cleanPath(path);
        if (this.backupMode)
            return clean ? `/${clean}` : '/';
        return `${this.remote || ''}:${clean ? `/${clean}` : '/'}`;
    }

    _openRemote() {
        if (!this.remote)
            return;
        this.path = cleanPath(this.path);
        this.selectedPath = this.path;
        const token = ++this.loadToken;
        this.nodes.clear();
        this.expanded = new Set(['']);
        this._setStatus('');
        this._renderTree();
        this._updateSelectionBar();
        this._updateSelectButton();
        this._loadNode('').then(() => {
            if (token !== this.loadToken)
                return null;
            return this._revealPath(this.path, token);
        }).then(found => {
            if (token !== this.loadToken)
                return;
            if (found === false && this.path) {
                this.selectedPath = '';
                this._renderTree();
            }
            this._setStatus('');
            this._refreshSelection();
            this._updateSelectionBar();
            this._updateSelectButton();
        }).catch(e => {
            if (token === this.loadToken)
                this._setStatus(e.message);
        });
    }

    _node(path) {
        let node = this.nodes.get(path);
        if (!node) {
            node = {loaded: false, error: null, entries: [], promise: null};
            this.nodes.set(path, node);
        }
        return node;
    }

    _loadNode(path) {
        const node = this._node(path);
        if (node.loaded)
            return Promise.resolve(node);
        if (node.promise)
            return node.promise;
        const token = this.loadToken;
        node.promise = (async () => {
            try {
                const entries = this.backupMode
                    ? await this.client.listBackup(this.jobId, this.version, path, false)
                    : await this.client.listRemote(
                        this.remote, path, this.mode === 'pick');
                if (token !== this.loadToken)
                    return node;
                node.entries = (entries || [])
                    .map(entry => ({
                        name: String(entry.name || ''),
                        isDir: Boolean(entry.isDir),
                        size: Number(entry.size || 0),
                    }))
                    .filter(entry => entry.name &&
                        (this.backupMode || this.mode !== 'pick' || entry.isDir))
                    .sort((a, b) => a.isDir === b.isDir
                        ? a.name.localeCompare(b.name)
                        : a.isDir ? -1 : 1);
                node.error = null;
                node.loaded = true;
            } catch (e) {
                if (token === this.loadToken) {
                    node.entries = [];
                    node.error = e.message;
                    node.loaded = true;
                }
            } finally {
                node.promise = null;
            }
            if (token === this.loadToken) {
                this._setStatus('');
                this._renderTree();
                this._updateSelectionBar();
            }
            return node;
        })();
        return node.promise;
    }

    async _revealPath(path, token) {
        const parts = cleanPath(path).split('/').filter(Boolean);
        if (parts.length === 0) {
            this.selectedPath = '';
            return true;
        }
        let prefix = '';
        for (const part of parts) {
            if (token !== this.loadToken)
                return false;
            await this._loadNode(prefix);
            const node = this.nodes.get(prefix);
            if (!node || node.error)
                return false;
            const entry = node.entries.find(item => item.name === part);
            if (!entry)
                return false;
            prefix = prefix ? `${prefix}/${part}` : part;
            if (entry.isDir)
                this.expanded.add(prefix);
            else
                break;
        }
        this.selectedPath = path;
        this._renderTree();
        return true;
    }

    _renderTree() {
        if (!this.remote)
            return;
        const adjustment = this.scrolled?.get_vadjustment();
        const scroll = adjustment?.get_value() || 0;
        this._clearList();
        this.rowByPath.clear();
        this._addTreeRow({
            path: '',
            name: this._rootLabel(),
            isDir: true,
            root: true,
            depth: 0,
            expanded: this.expanded.has(''),
        });
        const root = this.nodes.get('');
        if (root?.error) {
            this._addInfoRow(t('Cannot open folder: {message}', {
                message: root.error,
            }), 1);
        } else if (!root?.loaded) {
            this._addLoadingRow(1);
        } else if (this.expanded.has('')) {
            if (root.entries.length === 0)
                this._addInfoRow(t('Empty folder'), 1);
            else
                for (const entry of root.entries)
                    this._renderEntry(entry, '', 1);
        }
        this._updatingSelection = true;
        this.listBox.select_row(this.rowByPath.get(this.selectedPath) || null);
        this._updatingSelection = false;
        if (adjustment && scroll > 0) {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                adjustment.set_value(scroll);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _renderEntry(entry, parentPath, depth) {
        const path = parentPath ? `${parentPath}/${entry.name}` : entry.name;
        const expanded = entry.isDir && this.expanded.has(path);
        this._addTreeRow({
            path,
            name: entry.name,
            isDir: entry.isDir,
            size: entry.size,
            depth,
            expanded,
        });
        if (!expanded)
            return;
        const node = this.nodes.get(path);
        if (!node?.loaded) {
            this._addLoadingRow(depth + 1);
        } else if (node.error) {
            this._addInfoRow(t('Cannot open folder: {message}', {
                message: node.error,
            }), depth + 1);
        } else if (node.entries.length === 0) {
            this._addInfoRow(t('Empty folder'), depth + 1);
        } else {
            for (const child of node.entries)
                this._renderEntry(child, path, depth + 1);
        }
    }

    _addTreeRow({path, name, isDir, size, depth, expanded, root = false}) {
        const selected = path === this.selectedPath;
        const row = new Gtk.ListBoxRow({activatable: true});
        row.add_css_class('saveme-folder-row');
        row._treePath = path;
        row._treeEntry = {isDir, root};
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            margin_top: 4,
            margin_bottom: 4,
            margin_start: 6 + depth * 18,
            margin_end: 8,
        });
        if (isDir) {
            const expander = new Gtk.Button({
                icon_name: expanded ? 'pan-down-symbolic' : 'pan-end-symbolic',
                valign: Gtk.Align.CENTER,
                width_request: 22,
                height_request: 22,
                css_classes: ['flat', 'saveme-tree-expander'],
            });
            expander.connect('clicked', () => this._toggleNode(path));
            box.append(expander);
        } else {
            box.append(new Gtk.Box({width_request: 22}));
        }
        const iconName = root
            ? this.backupMode ? 'folder-documents-symbolic' : 'drive-harddisk-symbolic'
            : isDir
                ? expanded ? 'folder-open-symbolic' : 'folder-symbolic'
                : 'text-x-generic-symbolic';
        box.append(new Gtk.Image({
            icon_name: iconName,
            pixel_size: 18,
            valign: Gtk.Align.CENTER,
        }));
        box.append(new Gtk.Label({
            label: name,
            xalign: 0,
            hexpand: true,
            ellipsize: Pango.EllipsizeMode.END,
        }));
        if (!isDir) {
            box.append(new Gtk.Label({
                label: formatBytes(size),
                css_classes: ['caption', 'dim-label'],
            }));
        }
        const check = new Gtk.Image({
            icon_name: 'object-select-symbolic',
            visible: selected,
            css_classes: ['saveme-folder-check'],
        });
        box.append(check);
        row.set_child(box);
        row._check = check;
        row.set_tooltip_text(this._pathDisplay(path));
        if (selected)
            row.add_css_class('saveme-folder-selected');
        this.listBox.append(row);
        this.rowByPath.set(path, row);
    }

    _addInfoRow(text, depth) {
        const row = new Gtk.ListBoxRow({activatable: false, selectable: false});
        row.set_child(new Gtk.Label({
            label: text,
            xalign: 0,
            wrap: true,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 6 + depth * 18 + 30,
            margin_end: 8,
            css_classes: ['dim-label'],
        }));
        this.listBox.append(row);
    }

    _addLoadingRow(depth) {
        const row = new Gtk.ListBoxRow({activatable: false, selectable: false});
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            margin_top: 8,
            margin_bottom: 8,
            margin_start: 6 + depth * 18 + 30,
            margin_end: 8,
        });
        box.append(new Gtk.Spinner({spinning: true}));
        box.append(new Gtk.Label({
            label: t('Loading…'),
            css_classes: ['dim-label'],
        }));
        row.set_child(box);
        this.listBox.append(row);
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

    async _toggleNode(path) {
        if (this.expanded.has(path)) {
            this.expanded.delete(path);
            this._renderTree();
            return;
        }
        this.expanded.add(path);
        this._renderTree();
        if (!this.nodes.get(path)?.loaded) {
            this._setStatus(t('Loading…'));
            try {
                await this._loadNode(path);
            } finally {
                this._setStatus('');
            }
        }
    }

    _activateRow(row) {
        const entry = row?._treeEntry;
        if (!entry)
            return;
        if (entry.isDir) {
            this._toggleNode(row._treePath);
            return;
        }
        this._setSelected(row._treePath);
        if (this.backupMode)
            this._select();
    }

    _setSelected(path) {
        this.selectedPath = path;
        this.path = path;
        this._refreshSelection();
        this._updateSelectionBar();
        this._updateSelectButton();
    }

    _refreshSelection() {
        for (const [path, row] of this.rowByPath) {
            const selected = path === this.selectedPath;
            if (selected)
                row.add_css_class('saveme-folder-selected');
            else
                row.remove_css_class('saveme-folder-selected');
            if (row._check)
                row._check.visible = selected;
        }
        this._updatingSelection = true;
        this.listBox.select_row(this.rowByPath.get(this.selectedPath) || null);
        this._updatingSelection = false;
    }

    _updateSelectionBar() {
        if (!this.remote) {
            this.selectionBar.visible = false;
            return;
        }
        this.selectionBar.visible = true;
        const row = this.rowByPath.get(this.selectedPath);
        const isFile = Boolean(row && !row._treeEntry.isDir);
        this.selectionCaption.set_text(isFile ? t('Selected file') : t('Selected folder'));
        const display = this._pathDisplay(this.selectedPath);
        this.selectionLabel.set_text(display);
        this.selectionLabel.set_tooltip_text(display);
    }

    _updateSelectButton() {
        if (this.selectButton)
            this.selectButton.sensitive = Boolean(this.remote);
    }

    _newFolder() {
        if (this.backupMode || !this.remote)
            return;
        const parent = this.selectedPath || '';
        const dialog = new Adw.AlertDialog({
            heading: t('New folder'),
            body: parent
                ? t('Create a folder inside “{folder}”.', {
                    folder: this._pathDisplay(parent),
                })
                : t('Create a folder at the account root.'),
        });
        const entry = new Gtk.Entry({
            placeholder_text: t('Folder name'),
            activates_default: true,
        });
        dialog.set_extra_child(entry);
        dialog.add_response('cancel', t('Cancel'));
        dialog.add_response('create', t('Create'));
        dialog.set_response_appearance('create', Adw.ResponseAppearance.SUGGESTED);
        dialog.set_default_response('create');
        dialog.connect('response', (_dialog, response) => {
            if (response === 'create')
                this._createFolder(parent, entry.text);
        });
        dialog.present(this);
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            entry.grab_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _createFolder(parent, rawName) {
        const name = normalizeRemoteFolderName(rawName);
        if (!name) {
            this._setStatus(t('Folder name is required.'));
            return;
        }
        if (!isValidRemoteFolderName(name)) {
            this._setStatus(t('Enter a valid folder name without slashes.'));
            return;
        }
        if (this.newFolderButton)
            this.newFolderButton.sensitive = false;
        this._setStatus(t('Creating folder…'));
        try {
            const created = await this.client.createRemoteFolder(
                this.remote, parent, name);
            this.nodes.delete(parent);
            this.expanded.add(parent);
            await this._loadNode(parent);
            const path = created?.path ||
                (parent ? `${parent}/${created?.name || name}` : created?.name || name);
            this._setSelected(path);
            this._renderTree();
            this._refreshSelection();
            this._updateSelectionBar();
            this._setStatus('');
            this.mainWindow.toast?.(t('Folder created.'));
        } catch (e) {
            this._setStatus(t('Cannot create folder: {message}', {
                message: e.message,
            }));
        } finally {
            if (this.newFolderButton)
                this.newFolderButton.sensitive = true;
        }
    }

    _select() {
        if (this.backupMode) {
            this.onSelect?.({path: this.selectedPath || ''});
            this.close();
            return;
        }
        if (!this.remote) {
            this._setStatus(t('Choose a cloud account first.'));
            return;
        }
        this.onSelect?.({
            kind: 'remote',
            remote: this.remote,
            path: this.selectedPath || '',
        });
        this.close();
    }

    _copyPath() {
        const text = this._pathDisplay(this.selectedPath);
        try {
            this.get_clipboard().set(text);
            this.mainWindow.toast(t('Path copied.'));
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
