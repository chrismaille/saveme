import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {RemoteBrowserDialog} from './remote-browser.js';
import {t} from '../src/i18n.js';

const STEP_NAMES = ['version', 'path', 'target', 'review'];
const STEP_TITLES = [
    t('Version'), t('Path'), t('Target'), t('Review'),
];

export const RestoreDialog = GObject.registerClass({
    GTypeName: 'SaveMeRestoreDialog',
}, class RestoreDialog extends Adw.Window {
    constructor(parentWindow, job, {temporaryJob = false} = {}) {
        super({
            transient_for: parentWindow,
            modal: true,
            title: `${t('Restore')} — ${job.name}`,
            default_width: 760,
            default_height: 680,
        });
        this.parentWindow = parentWindow;
        this.client = parentWindow.client;
        this.job = job;
        this.temporary = temporaryJob;
        this.versions = [];
        this.target = null;
        this._step = 0;
        this._busy = false;
        this._build();
        this._loadVersions();
    }

    _build() {
        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();

        this.windowTitle = new Adw.WindowTitle({title: this.title});
        header.set_title_widget(this.windowTitle);

        this.cancelButton = new Gtk.Button({label: t('Cancel')});
        this.cancelButton.connect('clicked', () => this.close());
        header.pack_start(this.cancelButton);

        this.backButton = new Gtk.Button({
            icon_name: 'go-previous-symbolic',
            tooltip_text: t('Back'),
            css_classes: ['flat'],
        });
        this.backButton.connect('clicked', () => this._showStep(this._step - 1));
        header.pack_start(this.backButton);

        this.nextButton = new Gtk.Button({
            label: t('Next'),
            css_classes: ['suggested-action'],
        });
        this.nextButton.connect('clicked', () => this._next());
        header.pack_end(this.nextButton);

        this.restoreButton = new Gtk.Button({
            label: t('Restore'),
            css_classes: ['suggested-action'],
        });
        this.restoreButton.connect('clicked', () => this._restore());
        header.pack_end(this.restoreButton);

        toolbar.add_top_bar(header);

        this.stack = new Gtk.Stack({
            transition_type: Gtk.StackTransitionType.CROSSFADE,
            vexpand: true,
            hexpand: true,
        });
        this.stack.add_named(this._buildVersionPage(), STEP_NAMES[0]);
        this.stack.add_named(this._buildPathPage(), STEP_NAMES[1]);
        this.stack.add_named(this._buildTargetPage(), STEP_NAMES[2]);
        this.stack.add_named(this._buildReviewPage(), STEP_NAMES[3]);

        toolbar.set_content(this.stack);
        this.set_content(toolbar);
        this._showStep(0);
    }

    _buildVersionPage() {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: t('Version'),
            description: t('Choose the current backup or a dated version. ' +
                'Dated versions contain only files changed in that batch.'),
        });
        this.versionRow = new Adw.ComboRow({
            title: t('Version'),
            model: Gtk.StringList.new([t('Current backup')]),
            selected: 0,
        });
        this.versionRow.connect('notify::selected', () => {
            if (this.pathRow)
                this.pathRow.text = '';
        });
        group.add(this.versionRow);
        page.add(group);
        return page;
    }

    _buildPathPage() {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: t('Path'),
            description: t('Choose a file or folder inside the backup. Leave this ' +
                'empty to restore the whole selected source or version root.'),
        });
        this.pathRow = new Adw.EntryRow({
            title: t('File or folder inside the backup'),
            text: '',
        });
        const browse = new Gtk.Button({
            label: t('Browse'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        browse.connect('clicked', () => this._browse());
        this.pathRow.add_suffix(browse);
        group.add(this.pathRow);
        page.add(group);
        return page;
    }

    _buildTargetPage() {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: t('Target'),
            description: t('Choose the folder where restored files will be copied. ' +
                'The original source folder is never modified.'),
        });
        this.targetRow = new Adw.ActionRow({
            title: t('Target folder'),
            subtitle: t('Not selected'),
        });
        const choose = new Gtk.Button({
            label: t('Choose'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        choose.connect('clicked', () => this._chooseTarget());
        this.targetRow.add_suffix(choose);
        group.add(this.targetRow);
        page.add(group);
        return page;
    }

    _buildReviewPage() {
        const page = new Adw.PreferencesPage();

        const summaryGroup = new Adw.PreferencesGroup({
            title: t('Summary'),
            description: t('Review the restore settings, then start the restore.'),
        });
        this.jobSummaryRow = new Adw.ActionRow({
            title: t('Job'),
            subtitle: this.job.name || this.job.id,
        });
        this.versionSummaryRow = new Adw.ActionRow({title: t('Version')});
        this.pathSummaryRow = new Adw.ActionRow({title: t('Path')});
        this.targetSummaryRow = new Adw.ActionRow({title: t('Target')});
        summaryGroup.add(this.jobSummaryRow);
        summaryGroup.add(this.versionSummaryRow);
        summaryGroup.add(this.pathSummaryRow);
        summaryGroup.add(this.targetSummaryRow);
        page.add(summaryGroup);

        const optionsGroup = new Adw.PreferencesGroup({
            title: t('Options'),
            description: t('A dry run checks which files would be restored ' +
                'without writing any files.'),
        });
        this.dryRunRow = new Adw.SwitchRow({
            title: t('Dry run'),
            subtitle: t('Show what would be restored without writing files'),
            active: true,
        });
        optionsGroup.add(this.dryRunRow);
        page.add(optionsGroup);

        return page;
    }

    _showStep(index) {
        this._step = Math.max(0, Math.min(STEP_NAMES.length - 1, index));
        this.stack.set_visible_child_name(STEP_NAMES[this._step]);
        this.windowTitle.subtitle = `${STEP_TITLES[this._step]} ` +
            `(${this._step + 1}/${STEP_NAMES.length})`;
        if (this._step === STEP_NAMES.length - 1)
            this._updateSummary();
        this._updateNavigation();
    }

    _updateNavigation() {
        const last = this._step === STEP_NAMES.length - 1;
        const ready = this._canAdvance();
        this.backButton.visible = this._step > 0;
        this.backButton.sensitive = !this._busy;
        this.nextButton.visible = !last;
        this.nextButton.sensitive = !this._busy && ready;
        this.restoreButton.visible = last;
        this.restoreButton.sensitive = !this._busy && ready;
        this.cancelButton.sensitive = !this._busy;
        this.cancelButton.label = last ? t('Close') : t('Cancel');
        if (!this._busy)
            this.restoreButton.label = t('Restore');
    }

    _canAdvance() {
        if (this._step >= 2)
            return Boolean(this.target);
        return true;
    }

    _next() {
        if (this._busy || !this._canAdvance())
            return;
        if (this._step < STEP_NAMES.length - 1)
            this._showStep(this._step + 1);
    }

    _updateSummary() {
        this.versionSummaryRow.set_subtitle(this._selectedVersionLabel());
        this.pathSummaryRow.set_subtitle(
            String(this.pathRow.text || '').trim() || t('Entire source or version root'));
        this.targetSummaryRow.set_subtitle(this.target || t('Not selected'));
    }

    _selectedVersionLabel() {
        const index = this.versionRow.selected;
        if (index <= 0)
            return t('Current backup');
        const version = this.versions[index - 1];
        if (!version)
            return t('Current backup');
        if (!version.date)
            return version.name;
        return new Date(version.date).toLocaleString();
    }

    async _loadVersions() {
        try {
            const versions = await this.client.listVersions(this.job.id);
            this.versions = versions;
            const labels = [t('Current backup'),
                ...versions.map(version => {
                    if (!version.date)
                        return version.name;
                    return new Date(version.date).toLocaleString();
                })];
            this.versionRow.model = Gtk.StringList.new(labels);
            this.versionRow.selected = 0;
        } catch (e) {
            this.parentWindow.toast(
                t('Cannot list versions: {message}', {message: e.message}));
        }
    }

    _selectedVersion() {
        const index = this.versionRow.selected;
        return index > 0 ? this.versions[index - 1]?.name || '' : '';
    }

    _browse() {
        new RemoteBrowserDialog(this.parentWindow, {
            mode: 'pick',
            jobId: this.job.id,
            version: this._selectedVersion(),
            path: String(this.pathRow.text || '').trim(),
            transientFor: this,
            onSelect: selected => {
                this.pathRow.text = selected.path || '';
            },
        }).present();
    }

    _chooseTarget() {
        const dialog = new Gtk.FileDialog({title: t('Choose target folder'), modal: true});
        dialog.select_folder(this, null, (source, result) => {
            try {
                const file = source.select_folder_finish(result);
                const path = file.get_path();
                if (path) {
                    this.target = path;
                    this.targetRow.set_subtitle(path);
                    this._updateNavigation();
                }
            } catch (_) {
                // Dialog dismissed.
            }
        });
    }

    async _restore() {
        if (!this.target) {
            this.parentWindow.toast(t('Choose a target folder first.'));
            return;
        }
        if (!GLib.file_test(this.target, GLib.FileTest.IS_DIR)) {
            this.parentWindow.toast(t('Target folder does not exist.'));
            return;
        }
        const version = this._selectedVersion();
        const path = String(this.pathRow.text || '').trim();
        if (version && !path) {
            const dialog = new Adw.AlertDialog({
                heading: t('Restore changed files only?'),
                body: t('A dated version contains only files that were overwritten or deleted in that batch. ' +
                    'To restore the complete latest backup, choose Current backup. ' +
                    'To restore a single file from this date, browse and select it.'),
            });
            dialog.add_response('cancel', t('Cancel'));
            dialog.add_response('continue', t('Continue'));
            dialog.set_response_appearance('continue', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.connect('response', (_dialog, response) => {
                if (response === 'continue')
                    this._performRestore({version, path});
            });
            dialog.present(this);
            return;
        }
        await this._performRestore({version, path});
    }

    close(...args) {
        if (this.temporary) {
            this.temporary = false;
            this.client.deleteJob(this.job.id, false)
                .then(() => this.parentWindow.refresh())
                .catch(() => {});
        }
        return super.close(...args);
    }

    async _performRestore({version, path}) {
        const payload = {
            jobId: this.job.id,
            version,
            path,
            target: this.target,
            dryRun: Boolean(this.dryRunRow.active),
        };
        this._busy = true;
        this._updateNavigation();
        this.restoreButton.label = t('Restoring…');
        try {
            await this.client.restore(payload);
            this.parentWindow.toast(payload.dryRun
                ? t('Dry run completed. Check the target folder.')
                : t('Restore completed.'));
            if (!payload.dryRun)
                this.close();
        } catch (e) {
            const dialog = new Adw.AlertDialog({
                heading: t('Restore failed'),
                body: e.message,
            });
            dialog.add_response('ok', t('OK'));
            dialog.present(this);
        } finally {
            this._busy = false;
            this._updateNavigation();
        }
    }
});
