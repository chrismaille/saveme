import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {t} from '../src/i18n.js';

const PROVIDERS = ['drive', 'onedrive', 'dropbox', 'nextcloud', 's3', 'pcloud'];
const PROVIDER_LABELS = {
    drive: 'Google Drive',
    onedrive: 'Microsoft OneDrive',
    dropbox: 'Dropbox',
    nextcloud: 'Nextcloud',
    s3: 'S3 compatible',
    pcloud: 'pCloud',
};
const PROVIDER_LOGOS = {
    drive: 'google-drive.png',
    onedrive: 'onedrive.png',
    dropbox: 'dropbox.png',
    nextcloud: 'nextcloud.png',
    s3: 's3.png',
    pcloud: 'pcloud.png',
};
const MODULE_DIR = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);

export const AccountDialog = GObject.registerClass({
    GTypeName: 'SaveMeAccountDialog',
}, class AccountDialog extends Adw.Window {
    constructor(parentWindow, existing = null, options = {}) {
        super({
            transient_for: options.transientFor || parentWindow,
            modal: true,
            title: existing ? t('Reconnect') : t('Add account'),
            default_width: 720,
            default_height: 620,
        });
        this.window = parentWindow;
        this.client = parentWindow.client;
        this.onDone = options.onDone || null;
        this.initialProvider = options.provider || null;
        this.existing = existing;
        this.provider = this._initialProvider();
        this.authId = null;
        this.done = false;
        this.openedUrl = false;
        this.pollTimer = 0;
        this.unsubscribe = null;
        this._currentStep = null;
        this._nameTouched = false;
        this._updatingName = false;
        this._build();

        this.connect('close-request', () => {
            this._cleanup();
            return false;
        });
    }

    _initialProvider() {
        if (this.existing)
            return PROVIDERS.includes(this.existing.type) ? this.existing.type : 'drive';
        return PROVIDERS.includes(this.initialProvider) ? this.initialProvider : null;
    }

    _build() {
        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        this.windowTitle = new Adw.WindowTitle({title: this.title});
        header.set_title_widget(this.windowTitle);

        const cancel = new Gtk.Button({label: t('Cancel')});
        cancel.connect('clicked', () => this.close());
        header.pack_start(cancel);

        this.backButton = new Gtk.Button({
            icon_name: 'go-previous-symbolic',
            tooltip_text: t('Back'),
            css_classes: ['flat'],
            visible: false,
        });
        this.backButton.connect('clicked', () => this._back());
        header.pack_start(this.backButton);

        this.nextButton = new Gtk.Button({
            label: t('Next'),
            css_classes: ['suggested-action'],
        });
        this.nextButton.connect('clicked', () => this._next());
        header.pack_end(this.nextButton);

        this.connectButton = new Gtk.Button({
            label: t('Connect'),
            css_classes: ['suggested-action'],
            visible: false,
        });
        this.connectButton.connect('clicked', () => this._connect());
        header.pack_end(this.connectButton);

        toolbar.add_top_bar(header);

        this.stack = new Gtk.Stack({
            transition_type: Gtk.StackTransitionType.SLIDE_LEFT_RIGHT,
            transition_duration: 180,
        });
        this.stack.add_named(this._buildProviderPage(), 'provider');
        this.stack.add_named(this._buildOneDrivePage(), 'onedrive');
        this.stack.add_named(this._buildNextcloudUrlPage(), 'nextcloudUrl');
        this.stack.add_named(this._buildNextcloudUserPage(), 'nextcloudUser');
        this.stack.add_named(this._buildNextcloudPasswordPage(), 'nextcloudPassword');
        this.stack.add_named(this._buildS3EndpointPage(), 's3Endpoint');
        this.stack.add_named(this._buildS3RegionPage(), 's3Region');
        this.stack.add_named(this._buildS3AccessPage(), 's3Access');
        this.stack.add_named(this._buildS3SecretPage(), 's3Secret');
        this.stack.add_named(this._buildNamePage(), 'name');
        this.stack.add_named(this._buildAuthPage(), 'auth');
        toolbar.set_content(this.stack);
        this.set_content(toolbar);
        this._showStep(this._steps()[0]);
    }

    _buildProviderPage() {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: t('Choose a provider'),
            description: t('SaveMe supports Google Drive, Microsoft OneDrive, Dropbox, Nextcloud, S3 and pCloud.'),
        });
        const flow = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE,
            max_children_per_line: 3,
            column_spacing: 12,
            row_spacing: 12,
            homogeneous: true,
            margin_top: 8,
            margin_bottom: 8,
        });
        this.providerButtons = new Map();
        for (const provider of PROVIDERS) {
            const image = Gtk.Image.new_from_file(this._logoPath(provider));
            image.set_pixel_size(56);
            const content = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 10,
                margin_top: 12,
                margin_bottom: 12,
                margin_start: 12,
                margin_end: 12,
            });
            content.append(image);
            content.append(new Gtk.Label({
                label: t(PROVIDER_LABELS[provider]),
                css_classes: ['title-4'],
                wrap: true,
                xalign: 0.5,
                justify: Gtk.Justification.CENTER,
            }));
            const button = new Gtk.Button({
                height_request: 132,
                hexpand: true,
                css_classes: ['card'],
                child: content,
                tooltip_text: t(PROVIDER_LABELS[provider]),
            });
            button.connect('clicked', () => this._selectProvider(provider));
            flow.append(button);
            this.providerButtons.set(provider, button);
        }
        group.add(flow);
        page.add(group);
        this._renderProviderSelection();
        return page;
    }

    _buildOneDrivePage() {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: t('OneDrive account type'),
            description: t('Choose the account type for this Microsoft account.'),
        });
        this.oneDriveTypeRow = new Adw.ComboRow({
            title: t('Type'),
            model: Gtk.StringList.new([t('Personal'), t('Business')]),
            selected: this.existing?.options?.drive_type === 'business' ? 1 : 0,
        });
        group.add(this.oneDriveTypeRow);
        page.add(group);
        return page;
    }

    _buildNextcloudUrlPage() {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: t('Nextcloud address'),
            description: t('Enter the WebDAV address of your Nextcloud server, including ' +
                'the user folder. Example: https://cloud.example.com/remote.php/dav/files/user'),
        });
        this.nextcloudUrlRow = new Adw.EntryRow({
            title: t('Nextcloud URL'),
            text: this.existing?.options?.url || '',
        });
        this.nextcloudUrlRow.connect('notify::text', () => this._updateHeader());
        group.add(this.nextcloudUrlRow);
        page.add(group);
        return page;
    }

    _buildNextcloudUserPage() {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: t('Nextcloud user'),
            description: t('Use the Nextcloud user name that owns the files.'),
        });
        this.nextcloudUserRow = new Adw.EntryRow({
            title: t('User'),
            text: this.existing?.options?.user || '',
        });
        this.nextcloudUserRow.connect('notify::text', () => this._updateHeader());
        group.add(this.nextcloudUserRow);
        page.add(group);
        return page;
    }

    _buildNextcloudPasswordPage() {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: t('Nextcloud password'),
            description: t('Use an app password if two-factor authentication is enabled. ' +
                'The password is stored by rclone, not in the app configuration.'),
        });
        this.nextcloudPasswordRow = new Adw.PasswordEntryRow({
            title: t('Password or app password'),
        });
        this.nextcloudPasswordRow.connect('notify::text', () => this._updateHeader());
        group.add(this.nextcloudPasswordRow);
        page.add(group);
        return page;
    }

    _buildS3EndpointPage() {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: t('S3 endpoint'),
            description: t('Enter the S3-compatible endpoint, for example ' +
                'https://s3.eu-central-1.amazonaws.com or your provider URL.'),
        });
        this.s3EndpointRow = new Adw.EntryRow({
            title: t('Endpoint URL'),
            text: this.existing?.options?.endpoint || '',
        });
        this.s3EndpointRow.connect('notify::text', () => this._updateHeader());
        group.add(this.s3EndpointRow);
        page.add(group);
        return page;
    }

    _buildS3RegionPage() {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: t('S3 region'),
            description: t('Use the region requested by the provider, or "auto" when unsure.'),
        });
        this.s3RegionRow = new Adw.EntryRow({
            title: t('Region'),
            text: this.existing?.options?.region || 'auto',
        });
        this.s3RegionRow.connect('notify::text', () => this._updateHeader());
        group.add(this.s3RegionRow);
        page.add(group);
        return page;
    }

    _buildS3AccessPage() {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: t('S3 access key'),
            description: t('Use the access key ID generated by your S3 provider.'),
        });
        this.s3AccessRow = new Adw.EntryRow({title: t('Access key ID')});
        this.s3AccessRow.connect('notify::text', () => this._updateHeader());
        group.add(this.s3AccessRow);
        page.add(group);
        return page;
    }

    _buildS3SecretPage() {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: t('S3 secret key'),
            description: t('The secret key is stored by rclone, not in the app configuration.'),
        });
        this.s3SecretRow = new Adw.PasswordEntryRow({title: t('Secret access key')});
        this.s3SecretRow.connect('notify::text', () => this._updateHeader());
        group.add(this.s3SecretRow);
        page.add(group);
        return page;
    }

    _buildNamePage() {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: t('Name this account'),
            description: t('Use a name you will recognize in jobs and destinations.'),
        });
        this.nameRow = new Adw.EntryRow({
            title: t('Name'),
            text: this.existing?.name || '',
        });
        this.nameRow.connect('notify::text', () => {
            if (!this._updatingName)
                this._nameTouched = true;
            this._updateHeader();
        });
        group.add(this.nameRow);
        page.add(group);
        return page;
    }

    _buildAuthPage() {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: t('Authentication'),
            description: t('Connect the account to continue.'),
        });
        this.statusRow = new Adw.ActionRow({
            title: t('Status'),
            subtitle: t('Not started'),
        });
        this.urlLabel = new Gtk.Label({
            wrap: true,
            selectable: true,
            xalign: 0,
            visible: false,
        });
        this.urlLabel.add_css_class('saveme-url');
        this.openButton = new Gtk.Button({
            label: t('Open browser'),
            valign: Gtk.Align.CENTER,
            visible: false,
        });
        this.openButton.connect('clicked', () => this._openBrowser());
        this.urlRow = new Adw.ActionRow({title: t('Authorization URL')});
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
        group.add(this.statusRow);
        group.add(this.urlBox);
        group.add(this.errorLabel);
        page.add(group);
        return page;
    }

    _steps() {
        if (this.existing) {
            if (this._provider() === 'onedrive')
                return ['onedrive', 'auth'];
            if (this._provider() === 'nextcloud')
                return ['nextcloudUrl', 'nextcloudUser', 'nextcloudPassword', 'auth'];
            if (this._provider() === 's3')
                return ['s3Endpoint', 's3Region', 's3Access', 's3Secret', 'auth'];
            return ['auth'];
        }
        const steps = ['provider'];
        if (this._provider() === 'onedrive')
            steps.push('onedrive');
        if (this._provider() === 'nextcloud')
            steps.push('nextcloudUrl', 'nextcloudUser', 'nextcloudPassword');
        if (this._provider() === 's3')
            steps.push('s3Endpoint', 's3Region', 's3Access', 's3Secret');
        steps.push('name', 'auth');
        return steps;
    }

    _showStep(step) {
        const steps = this._steps();
        if (!steps.includes(step))
            step = steps[0];
        if (this._currentStep === 'auth' && step !== 'auth')
            this._resetAuth();
        this._currentStep = step;
        if (step === 'name')
            this._syncNameDefault();
        this.stack.set_visible_child_name(step);
        this._updateHeader();
    }

    _next() {
        const steps = this._steps();
        const index = steps.indexOf(this._currentStep);
        if (index >= 0 && index < steps.length - 1)
            this._showStep(steps[index + 1]);
    }

    _back() {
        const steps = this._steps();
        const index = steps.indexOf(this._currentStep);
        if (index > 0)
            this._showStep(steps[index - 1]);
    }

    _updateHeader() {
        if (!this.backButton)
            return;
        const steps = this._steps();
        const index = steps.indexOf(this._currentStep);
        const onAuth = this._currentStep === 'auth';
        this.backButton.visible = index > 0;
        this.nextButton.visible = !onAuth;
        this.connectButton.visible = onAuth;
        this.nextButton.sensitive = !onAuth && this._canAdvance();
    }

    _canAdvance() {
        if (this._currentStep === 'provider')
            return Boolean(this._provider());
        if (this._currentStep === 'name')
            return Boolean(String(this.nameRow?.text || '').trim());
        if (this._currentStep === 'nextcloudUrl')
            return Boolean(String(this.nextcloudUrlRow?.text || '').trim());
        if (this._currentStep === 'nextcloudUser')
            return Boolean(String(this.nextcloudUserRow?.text || '').trim());
        if (this._currentStep === 'nextcloudPassword')
            return Boolean(String(this.nextcloudPasswordRow?.text || '').trim());
        if (this._currentStep === 's3Endpoint')
            return Boolean(String(this.s3EndpointRow?.text || '').trim());
        if (this._currentStep === 's3Region')
            return Boolean(String(this.s3RegionRow?.text || '').trim());
        if (this._currentStep === 's3Access')
            return Boolean(String(this.s3AccessRow?.text || '').trim());
        if (this._currentStep === 's3Secret')
            return Boolean(String(this.s3SecretRow?.text || '').trim());
        return true;
    }

    _selectProvider(provider) {
        if (this.existing || !PROVIDERS.includes(provider))
            return;
        this.provider = provider;
        this._renderProviderSelection();
        this._syncNameDefault();
        this._updateHeader();
        if (this._currentStep === 'provider')
            this._showStep(this._steps()[1]);
    }

    _renderProviderSelection() {
        if (!this.providerButtons)
            return;
        for (const [provider, button] of this.providerButtons) {
            if (provider === this.provider)
                button.add_css_class('suggested-action');
            else
                button.remove_css_class('suggested-action');
        }
    }

    _suggestedName() {
        return this._uniqueName(this._defaultName());
    }

    _defaultName() {
        if (this._provider() === 'drive')
            return t('Google Drive connection');
        if (this._provider() === 'onedrive')
            return t('OneDrive connection');
        if (this._provider() === 'dropbox')
            return t('Dropbox connection');
        if (this._provider() === 'nextcloud')
            return t('Nextcloud connection');
        if (this._provider() === 's3')
            return t('S3 connection');
        if (this._provider() === 'pcloud')
            return t('pCloud connection');
        return t('Cloud connection');
    }

    _uniqueName(base) {
        const name = String(base || '').trim() || t('Cloud connection');
        const used = new Set((this.window.snapshot?.remotes || [])
            .map(remote => String(remote.name || '')));
        if (!used.has(name))
            return name;
        let suffix = 2;
        while (used.has(`${name} ${suffix}`))
            suffix++;
        return `${name} ${suffix}`;
    }

    _syncNameDefault() {
        if (this.existing || !this.nameRow)
            return;
        const current = String(this.nameRow.text || '').trim();
        if (this._nameTouched && current)
            return;
        const suggestion = this._suggestedName();
        if (this.nameRow.text === suggestion)
            return;
        this._updatingName = true;
        this.nameRow.text = suggestion;
        this._updatingName = false;
        this._nameTouched = false;
    }

    _logoPath(provider) {
        return GLib.build_filenamev([
            MODULE_DIR,
            '..',
            'assets',
            PROVIDER_LOGOS[provider],
        ]);
    }

    _provider() {
        return this.provider;
    }

    _options() {
        if (this._provider() === 'onedrive') {
            return {
                ...(this.existing?.options || {}),
                drive_type: this.oneDriveTypeRow.selected === 1 ? 'business' : 'personal',
            };
        }
        if (this.existing?.options?.drive_type)
            return {...this.existing.options};
        return {};
    }

    async _connect() {
        if (this._provider() === 'nextcloud') {
            await this._connectNextcloud();
            return;
        }
        if (this._provider() === 's3') {
            await this._connectS3();
            return;
        }
        const name = this.existing
            ? String(this.existing.name || '').trim()
            : String(this.nameRow.text || '').trim();
        if (!name) {
            this._showError(t('Remote name is required.'));
            return;
        }
        this.unsubscribe?.();
        this.unsubscribe = null;
        if (this.pollTimer) {
            GLib.source_remove(this.pollTimer);
            this.pollTimer = 0;
        }
        this.openedUrl = false;
        this.done = false;
        this.connectButton.label = t('Connect');
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
            this.statusRow.set_subtitle(this._statusLabel('starting'));
        } catch (e) {
            this.connectButton.sensitive = true;
            this._showError(e.message);
        }
    }

    async _connectNextcloud() {
        const name = this.existing
            ? String(this.existing.name || '').trim()
            : String(this.nameRow.text || '').trim();
        const url = String(this.nextcloudUrlRow?.text || '').trim();
        const user = String(this.nextcloudUserRow?.text || '').trim();
        const pass = String(this.nextcloudPasswordRow?.text || '');
        if (!name || !url || !user || !pass) {
            this._showError(t('Fill in the Nextcloud URL, user and password.'));
            return;
        }
        this.connectButton.sensitive = false;
        this.connectButton.label = t('Connect');
        this.errorLabel.visible = false;
        this.statusRow.set_subtitle(t('Connecting…'));
        try {
            await this.client.createRemote({
                name,
                type: 'nextcloud',
                options: {url, user, pass},
            });
            this.done = true;
            await this.window.refresh();
            this.window.toast(t('Account connected.'));
            this.onDone?.();
            this.close();
        } catch (e) {
            this.connectButton.sensitive = true;
            this.connectButton.label = t('Retry');
            this._showError(e.message);
        }
    }

    async _connectS3() {
        const name = this.existing
            ? String(this.existing.name || '').trim()
            : String(this.nameRow.text || '').trim();
        const endpoint = String(this.s3EndpointRow?.text || '').trim();
        const region = String(this.s3RegionRow?.text || '').trim() || 'auto';
        const accessKey = String(this.s3AccessRow?.text || '').trim();
        const secretKey = String(this.s3SecretRow?.text || '');
        if (!name || !endpoint || !accessKey || !secretKey) {
            this._showError(t('Fill in the S3 endpoint, access key and secret key.'));
            return;
        }
        this.connectButton.sensitive = false;
        this.connectButton.label = t('Connect');
        this.errorLabel.visible = false;
        this.statusRow.set_subtitle(t('Connecting…'));
        try {
            await this.client.createRemote({
                name,
                type: 's3',
                options: {
                    endpoint,
                    region,
                    accessKey,
                    secretKey,
                },
            });
            this.done = true;
            await this.window.refresh();
            this.window.toast(t('Account connected.'));
            this.onDone?.();
            this.close();
        } catch (e) {
            this.connectButton.sensitive = true;
            this.connectButton.label = t('Retry');
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
        this.statusRow.set_subtitle(this._statusLabel(auth.status));
        if (auth.url) {
            this.urlLabel.set_text(this._authUrl(auth.url));
            this.urlLabel.visible = true;
            this.urlRow.visible = true;
            this.openButton.visible = true;
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
            this.window.toast(t('Account connected.'));
            this.onDone?.();
            this.close();
        } else if (auth.status === 'error' || auth.status === 'cancelled') {
            this.connectButton.sensitive = true;
            this.connectButton.label = t('Retry');
            if (auth.status === 'cancelled')
                this.statusRow.set_subtitle(t('Cancelled'));
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

    _authUrl(url) {
        if (this._provider() === 'onedrive' && !/[?&]prompt=/i.test(url)) {
            const separator = url.includes('?') ? '&' : '?';
            return `${url}${separator}prompt=select_account`;
        }
        return url;
    }

    _statusLabel(status) {
        if (status === 'starting')
            return t('Starting authorization…');
        if (status === 'waiting')
            return t('Waiting for browser sign-in…');
        if (status === 'exchanging')
            return t('Finishing authorization…');
        if (status === 'done')
            return t('Connected');
        if (status === 'error')
            return t('Error');
        if (status === 'cancelled')
            return t('Cancelled');
        return status || '';
    }

    _resetAuth() {
        this._cleanup();
        this.authId = null;
        this.done = false;
        this.openedUrl = false;
        this.connectButton.sensitive = true;
        this.connectButton.label = t('Connect');
        this.statusRow.set_subtitle(t('Not started'));
        this.urlLabel.set_text('');
        this.urlLabel.visible = false;
        this.urlRow.visible = false;
        this.openButton.visible = false;
        this._showError('');
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
