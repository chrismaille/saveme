import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';

const PROVIDERS = ['drive', 'onedrive', 'dropbox'];
const PROVIDER_LABELS = ['Google Drive', 'Microsoft OneDrive', 'Dropbox'];
const DEFAULT_NAMES = {drive: 'drive', onedrive: 'onedrive', dropbox: 'dropbox'};

export const AccountDialog = GObject.registerClass({
    GTypeName: 'SaveMeAccountDialog',
}, class AccountDialog extends Adw.Window {
    constructor(parentWindow, existing = null, options = {}) {
        super({
            transient_for: options.transientFor || parentWindow,
            modal: true,
            title: existing ? 'Reauthenticate account' : 'Add account',
            default_width: 620,
            default_height: 520,
        });
        this.window = parentWindow;
        this.client = parentWindow.client;
        this.onDone = options.onDone || null;
        this.initialProvider = options.provider || null;
        this.existing = existing;
        this.authId = null;
        this.done = false;
        this.openedUrl = false;
        this.pollTimer = 0;
        this.unsubscribe = null;
        this._build();

        this.connect('close-request', () => {
            this._cleanup();
            return false;
        });
    }

    _build() {
        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        header.set_title_widget(new Adw.WindowTitle({title: this.title}));
        const cancel = new Gtk.Button({label: 'Cancel'});
        cancel.connect('clicked', () => this.close());
        header.pack_start(cancel);
        this.connectButton = new Gtk.Button({
            label: 'Connect',
            css_classes: ['suggested-action'],
        });
        this.connectButton.connect('clicked', () => this._connect());
        header.pack_end(this.connectButton);
        toolbar.add_top_bar(header);

        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({title: 'Account'});
        const providerIndex = this.existing
            ? Math.max(0, PROVIDERS.indexOf(this.existing.type))
            : Math.max(0, PROVIDERS.indexOf(this.initialProvider || 'drive'));
        this.providerRow = new Adw.ComboRow({
            title: 'Provider',
            model: Gtk.StringList.new(PROVIDER_LABELS),
            selected: providerIndex,
        });
        this.providerRow.sensitive = !this.existing;
        this.providerRow.connect('notify::selected', () => this._updateVisibility());
        this.nameRow = new Adw.EntryRow({
            title: 'Remote name',
            text: this.existing?.name || DEFAULT_NAMES[PROVIDERS[providerIndex]],
        });
        this.nameRow.sensitive = !this.existing;
        this.oneDriveTypeRow = new Adw.ComboRow({
            title: 'OneDrive account type',
            model: Gtk.StringList.new(['Personal', 'Business']),
            selected: this.existing?.options?.drive_type === 'business' ? 1 : 0,
        });
        group.add(this.providerRow);
        group.add(this.nameRow);
        group.add(this.oneDriveTypeRow);
        page.add(group);

        const statusGroup = new Adw.PreferencesGroup({title: 'Authentication'});
        this.statusRow = new Adw.ActionRow({
            title: 'Status',
            subtitle: 'Not started',
        });
        this.urlLabel = new Gtk.Label({
            wrap: true,
            selectable: true,
            xalign: 0,
            visible: false,
        });
        this.urlLabel.add_css_class('saveme-url');
        this.openButton = new Gtk.Button({
            label: 'Open browser',
            valign: Gtk.Align.CENTER,
            visible: false,
        });
        this.openButton.connect('clicked', () => this._openBrowser());
        this.urlRow = new Adw.ActionRow({title: 'Authorization URL'});
        this.urlRow.add_suffix(this.openButton);
        this.urlRow.visible = false;
        this.urlBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin_top: 6,
            margin_bottom: 6,
        });
        this.urlBox.append(this.urlLabel);
        this.urlBox.append(this.urlRow);
        this.errorLabel = new Gtk.Label({
            wrap: true,
            xalign: 0,
            visible: false,
            css_classes: ['error'],
        });
        statusGroup.add(this.statusRow);
        statusGroup.add(this.urlBox);
        statusGroup.add(this.errorLabel);
        page.add(statusGroup);

        toolbar.set_content(page);
        this.set_content(toolbar);
        this._updateVisibility();
    }

    _updateVisibility() {
        this.oneDriveTypeRow.visible = this.providerRow.selected === 1;
    }

    _provider() {
        return PROVIDERS[this.providerRow.selected] || 'drive';
    }

    _options() {
        if (this.existing?.options?.drive_type)
            return {...this.existing.options};
        if (this._provider() === 'onedrive') {
            return {
                drive_type: this.oneDriveTypeRow.selected === 1 ? 'business' : 'personal',
            };
        }
        return {};
    }

    async _connect() {
        const name = String(this.nameRow.text || '').trim();
        if (!name) {
            this._showError('Remote name is required.');
            return;
        }
        this.unsubscribe?.();
        this.unsubscribe = null;
        if (this.pollTimer) {
            GLib.source_remove(this.pollTimer);
            this.pollTimer = 0;
        }
        this.openedUrl = false;
        this.connectButton.sensitive = false;
        this.errorLabel.visible = false;
        try {
            this.authId = await this.client.beginRemoteAuth(
                this._provider(), name, this._options());
            this.unsubscribe = this.client.onRemoteAuth((authId, json) => {
                if (authId === this.authId)
                    this._applyAuth(json);
            });
            this.pollTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                if (this.authId && !this.done)
                    this._refreshAuth();
                return GLib.SOURCE_CONTINUE;
            });
            this.statusRow.set_subtitle('Starting rclone authorization…');
        } catch (e) {
            this.connectButton.sensitive = true;
            this._showError(e.message);
        }
    }

    async _refreshAuth() {
        if (!this.authId || this.done)
            return;
        try {
            const auth = await this.client.getRemoteAuth(this.authId);
            await this._applyAuthObject(auth);
        } catch (e) {
            this._showError(e.message);
        }
    }

    async _applyAuth(json) {
        try {
            await this._applyAuthObject(JSON.parse(json));
        } catch (_) {
            // Ignore malformed auth state.
        }
    }

    async _applyAuthObject(auth) {
        if (!auth)
            return;
        this.statusRow.set_subtitle(auth.status);
        if (auth.url) {
            this.urlLabel.set_text(auth.url);
            this.urlLabel.visible = true;
            this.urlRow.visible = true;
            if (!this.openedUrl) {
                this.openedUrl = true;
                this._openBrowser();
            }
        }
        if (auth.error)
            this._showError(auth.error);
        if (auth.status === 'done') {
            this.done = true;
            this._cleanup();
            try {
                await this.window.refresh();
            } catch (_) {
                // Best effort.
            }
            this.window.toast('Account connected.');
            this.onDone?.();
            this.close();
        } else if (auth.status === 'error' || auth.status === 'cancelled') {
            this.connectButton.sensitive = true;
            this.connectButton.label = 'Retry';
            if (auth.status === 'cancelled')
                this.statusRow.set_subtitle('Cancelled');
        }
    }

    _openBrowser() {
        const url = this.urlLabel.get_text();
        if (!url)
            return;
        try {
            Gio.AppInfo.launch_default_for_uri(url, null);
        } catch (e) {
            this._showError(e.message);
        }
    }

    _showError(message) {
        this.errorLabel.set_text(message || '');
        this.errorLabel.visible = Boolean(message);
    }

    _cleanup() {
        if (this.pollTimer) {
            GLib.source_remove(this.pollTimer);
            this.pollTimer = 0;
        }
        this.unsubscribe?.();
        this.unsubscribe = null;
        if (this.authId && !this.done) {
            this.client.cancelRemoteAuth(this.authId).catch(() => {});
            this.authId = null;
        }
    }
});
