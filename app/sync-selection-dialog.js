import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {normalizeIncludes} from '../src/domain/include-filter.js';
import {formatBytes} from './presentation/format.js';
import {t} from '../src/i18n.js';

function readRootEntries(rootPath) {
    const file = Gio.File.new_for_path(rootPath);
    const enumerator = file.enumerate_children(
        'standard::name,standard::type,standard::size',
        Gio.FileQueryInfoFlags.NONE,
        null);
    const entries = [];
    let info;
    while ((info = enumerator.next_file(null)) !== null) {
        const name = info.get_name();
        if (!name)
            continue;
        entries.push({
            name,
            isDir: info.get_file_type() === Gio.FileType.DIRECTORY,
            size: info.get_size(),
        });
    }
    enumerator.close(null);
    entries.sort((a, b) => {
        if (a.isDir !== b.isDir)
            return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
    return entries;
}

/**
 * Select root-level folders/files that should be included in a sync. Selected
 * folders include their descendants; the job's exclude filters still apply.
 */
export const SyncSelectionDialog = GObject.registerClass({
    GTypeName: 'SaveMeSyncSelectionDialog',
}, class SyncSelectionDialog extends Adw.Window {
    constructor(parentWindow, {
        rootPath = '',
        selected = [],
        transientFor = null,
        onDone = null,
    } = {}) {
        super({
            transient_for: transientFor || parentWindow,
            modal: true,
            title: t('Select sync content'),
            default_width: 640,
            default_height: 640,
        });
        this.parentWindow = parentWindow;
        this.rootPath = rootPath;
        this.onDone = onDone;
        const initial = normalizeIncludes(selected);
        this._allMode = initial.length === 0;
        this._selected = new Set(initial);
        this._entries = [];
        this._build();
        this._load();
    }

    _build() {
        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        const close = new Gtk.Button({label: t('Cancel')});
        close.connect('clicked', () => this.close());
        header.pack_start(close);
        this.applyButton = new Gtk.Button({
            label: t('Apply'),
            css_classes: ['suggested-action'],
        });
        this.applyButton.connect('clicked', () => this._apply());
        header.pack_end(this.applyButton);
        toolbar.add_top_bar(header);

        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
        });
        this.noteLabel = new Gtk.Label({
            label: t('Selected folders include their descendants. Exclude filters ' +
                'still apply inside them.'),
            xalign: 0,
            wrap: true,
            margin_start: 16,
            margin_end: 16,
            margin_top: 10,
            css_classes: ['dim-label'],
        });
        this.rootLabel = new Gtk.Label({
            label: this.rootPath || t('No source selected'),
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.END,
            margin_start: 16,
            margin_end: 16,
            css_classes: ['saveme-sidebar-paths'],
        });
        this.search = new Gtk.SearchEntry({
            placeholder_text: t('Filter root items…'),
            margin_start: 16,
            margin_end: 16,
        });
        this.search.connect('search-changed', () => this._filterRows());

        const buttons = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            margin_start: 16,
            margin_end: 16,
        });
        const selectAll = new Gtk.Button({label: t('Select all')});
        selectAll.connect('clicked', () => this._setAll(true));
        const clear = new Gtk.Button({label: t('Clear')});
        clear.connect('clicked', () => this._setAll(false));
        buttons.append(selectAll);
        buttons.append(clear);
        content.append(this.noteLabel);
        content.append(this.rootLabel);
        content.append(this.search);
        content.append(buttons);

        this.errorLabel = new Gtk.Label({
            xalign: 0,
            wrap: true,
            visible: false,
            margin_start: 16,
            margin_end: 16,
            css_classes: ['error'],
        });
        content.append(this.errorLabel);

        this.page = new Adw.PreferencesPage({vexpand: true});
        this.group = new Adw.PreferencesGroup({title: t('Root content')});
        this.page.add(this.group);
        content.append(this.page);
        toolbar.set_content(content);
        this.set_content(toolbar);
    }

    _load() {
        try {
            if (!this.rootPath)
                throw new Error(t('Choose a local source folder first.'));
            this._entries = readRootEntries(this.rootPath);
            this._render();
        } catch (e) {
            this._entries = [];
            this._showError(e.message);
            this.applyButton.sensitive = false;
        }
    }

    _render() {
        const rows = this._entries.map(entry => {
            const check = new Gtk.CheckButton({
                active: this._allMode || this._selected.has(entry.name),
                valign: Gtk.Align.CENTER,
            });
            const row = new Adw.ActionRow({
                title: entry.name,
                subtitle: entry.isDir ? t('Folder') : formatBytes(entry.size),
            });
            row.add_prefix(new Gtk.Image({
                icon_name: entry.isDir
                    ? 'folder-symbolic' : 'text-x-generic-symbolic',
                pixel_size: 18,
            }));
            row.add_suffix(check);
            row.set_activatable(true);
            row.connect('activated', () => {
                check.active = !check.active;
            });
            return {entry, row, check};
        });
        this._entries = rows;
        for (const {row} of rows)
            this.group.add(row);
        if (rows.length === 0)
            this._showError(t('This source folder is empty.'));
        this._filterRows();
    }

    _filterRows() {
        const needle = this.search.text.trim().toLocaleLowerCase();
        for (const {entry, row} of this._entries)
            row.visible = !needle || entry.name.toLocaleLowerCase().includes(needle);
    }

    _setAll(active) {
        for (const {row, check} of this._entries) {
            if (row.visible)
                check.active = active;
        }
        this.errorLabel.visible = false;
    }

    _showError(message) {
        this.errorLabel.set_text(message || '');
        this.errorLabel.visible = Boolean(message);
    }

    _apply() {
        const active = this._entries
            .filter(entry => entry.check.active)
            .map(entry => entry.entry.name);
        if (this._entries.length === 0 || active.length === 0) {
            this._showError(t('Select at least one folder or file.'));
            return;
        }
        const all = active.length === this._entries.length;
        this.onDone?.(all ? [] : active);
        this.close();
    }
});
