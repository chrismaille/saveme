import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {JobEditor} from './job-editor.js';
import {AccountDialog} from './account-dialog.js';
import {RestoreDialog} from './restore-dialog.js';
import {LogDialog} from './log-dialog.js';
import {RemoteBrowserDialog} from './remote-browser.js';
import {VolumeResolver} from '../src/volumes.js';
import {JOB_TYPES, localPathFor} from '../src/jobs.js';
import {sleep} from '../src/util.js';
import {SystemLauncher} from './gateway/system-launcher.js';
import {JobsPage} from './pages/jobs-page.js';
import {AccountsPage} from './pages/accounts-page.js';
import {LogsPage} from './pages/logs-page.js';
import {SettingsPage} from './pages/settings-page.js';
import {DebugPage} from './pages/debug-page.js';

const APP_DIR = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const ROOT_DIR = GLib.build_filenamev([APP_DIR, '..']);

export const SaveMeWindow = GObject.registerClass({
    GTypeName: 'SaveMeSettingsWindow',
}, class SaveMeWindow extends Adw.ApplicationWindow {
    constructor(app, client, {monitor = null, appLog = null} = {}) {
        super({
            application: app,
            title: 'SaveMe',
            default_width: 980,
            default_height: 720,
        });
        this.app = app;
        this.client = client;
        this.monitor = monitor;
        this.appLog = appLog;
        this.volumes = new VolumeResolver();
        this.launcher = new SystemLauncher();
        this.snapshot = null;
        this._daemonStatus = null;
        this._unsubscribe = null;
        this._monitorUnsubscribe = null;
        this._buildUI();
        this._monitorUnsubscribe = this.monitor?.onSample(metrics => {
            this.settingsPage.updatePerformance(metrics);
            this.debugPage.updatePerformance(metrics);
        }) || null;
        this.settingsPage.updatePerformance(this.monitor?.snapshot());
        this.debugPage.updatePerformance(this.monitor?.snapshot());

        this._unsubscribe = this.client.onSnapshot(json => {
            try {
                this._applySnapshot(JSON.parse(json));
            } catch (e) {
                this.toast(`Invalid snapshot: ${e.message}`);
            }
        });
        this.connect('close-request', () => {
            this._unsubscribe?.();
            this._unsubscribe = null;
            this._monitorUnsubscribe?.();
            this._monitorUnsubscribe = null;
            return false;
        });
        this.refresh();
    }

    _buildUI() {
        const header = new Adw.HeaderBar();
        this.stack = new Adw.ViewStack();
        this.viewSwitcher = new Adw.ViewSwitcherTitle({stack: this.stack});
        header.set_title_widget(this.viewSwitcher);

        const newJob = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: 'New job',
            css_classes: ['flat'],
        });
        newJob.connect('clicked', () => this.newJob());
        header.pack_end(newJob);
        const refresh = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: 'Refresh',
            css_classes: ['flat'],
        });
        refresh.connect('clicked', () => this.refresh());
        header.pack_end(refresh);

        this.jobsPage = new JobsPage(this);
        this.accountsPage = new AccountsPage(this);
        this.logsPage = new LogsPage(this);
        this.settingsPage = new SettingsPage(this);
        this.debugPage = new DebugPage(this);
        const jobsPage = this.stack.add_titled(this.jobsPage.widget, 'jobs', 'Jobs');
        jobsPage.set_icon_name('view-list-symbolic');
        const accountsPage = this.stack.add_titled(this.accountsPage.widget, 'accounts', 'Accounts');
        accountsPage.set_icon_name('system-users-symbolic');
        const logsPage = this.stack.add_titled(this.logsPage.widget, 'logs', 'Logs');
        logsPage.set_icon_name('text-x-generic-symbolic');
        const settingsPage = this.stack.add_titled(this.settingsPage.widget, 'settings', 'Settings');
        settingsPage.set_icon_name('emblem-system-symbolic');
        const debugPage = this.stack.add_titled(this.debugPage.widget, 'debug', 'Debug');
        debugPage.set_icon_name('utilities-terminal-symbolic');

        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(header);
        toolbar.set_content(this.stack);
        this.toastOverlay = new Adw.ToastOverlay();
        this.toastOverlay.set_child(toolbar);
        this.set_content(this.toastOverlay);
    }

    async refresh() {
        let lastError = null;
        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                const snapshot = await this.client.getSnapshot();
                this._applySnapshot(snapshot);
                return;
            } catch (e) {
                lastError = e;
                await sleep(250);
            }
        }
        if (this.snapshot)
            return;
        this._showDaemonError(lastError || new Error('Daemon unavailable'));
    }

    _applySnapshot(snapshot) {
        this.snapshot = snapshot;
        if (this.get_content() === this._daemonStatus)
            this.set_content(this.toastOverlay);
        this.jobsPage.update(snapshot);
        this.accountsPage.update(snapshot);
        this.logsPage.update(snapshot);
        this.settingsPage.update(snapshot);
        this.debugPage.update(snapshot);
    }

    _showDaemonError(error) {
        if (!this._daemonStatus) {
            const page = new Adw.StatusPage({
                title: 'SaveMe daemon is not running',
                icon_name: 'dialog-warning-symbolic',
            });
            const box = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 8,
                halign: Gtk.Align.CENTER,
            });
            const start = new Gtk.Button({
                label: 'Start daemon',
                css_classes: ['suggested-action'],
            });
            start.connect('clicked', () => this._startDaemon());
            const retry = new Gtk.Button({label: 'Retry'});
            retry.connect('clicked', () => this.refresh());
            box.append(start);
            box.append(retry);
            page.set_child(box);
            this._daemonStatus = page;
        }
        this._daemonStatus.set_description(error.message);
        this.set_content(this._daemonStatus);
    }

    async _startDaemon() {
        // The D-Bus service may already be activating the daemon. Give it a
        // chance before spawning a second process.
        try {
            const snapshot = await this.client.getSnapshot();
            this._applySnapshot(snapshot);
            return;
        } catch (_) {
            // Continue and spawn it.
        }
        try {
            const program = this.launcher.find('saveme-daemon');
            let argv = null;
            if (program) {
                argv = [program];
            } else {
                const script = GLib.build_filenamev([ROOT_DIR, 'bin', 'saveme-daemon.js']);
                if (GLib.file_test(script, GLib.FileTest.EXISTS))
                    argv = ['gjs', '-m', script];
            }
            if (!argv) {
                this.toast('saveme-daemon is not installed.');
                return;
            }
            this.launcher.spawn(argv, {silent: true});
            await sleep(800);
            this.refresh();
        } catch (e) {
            this.toast(e.message);
        }
    }

    toast(message) {
        this.toastOverlay.add_toast(new Adw.Toast({title: message}));
    }

    showView(name, jobId = null) {
        if (['jobs', 'accounts', 'logs', 'settings', 'debug'].includes(name))
            this.stack.set_visible_child_name(name);
        if (name === 'logs' && jobId)
            this.logsPage.selectJob(jobId);
        if (name === 'logs')
            this.logsPage.onShown();
        if (name === 'debug')
            this.debugPage.onShown();
    }

    newJob() {
        new JobEditor(this, null).present();
    }

    editJob(job) {
        new JobEditor(this, job).present();
    }

    addAccount(existing = null) {
        new AccountDialog(this, existing).present();
    }

    openLogs(jobId = null) {
        this.showView('logs', jobId);
    }

    openAppLog() {
        new LogDialog(this, 'Application log',
            this.appLog?.readTail(1000) || '(empty)').present();
    }

    openSource(job, source = null) {
        this._openJobPath(source || job.source);
    }

    openDestination(job) {
        this._openJobPath(job.destination);
    }

    openBackupRoot(job) {
        if (!job || job.type !== JOB_TYPES.BACKUP)
            return this.openDestination(job);
        if (job.destination.kind === 'remote') {
            const path = job.destination.path
                ? `${job.destination.path.replace(/\/+$/, '')}/SaveMe/${job.id}`
                : `SaveMe/${job.id}`;
            new RemoteBrowserDialog(this, {
                mode: 'browse',
                remote: job.destination.remote,
                path,
            }).present();
            return;
        }
        let base;
        try {
            base = localPathFor(job.destination, this.volumes);
        } catch (e) {
            this.toast(e.message);
            return;
        }
        const path = `${String(base || '').replace(/\/+$/, '')}/SaveMe/${job.id}`;
        if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
            this.toast(`Backup folder not created yet: ${path}`);
            return;
        }
        try {
            this.launcher.openPath(path);
        } catch (e) {
            this.toast(e.message);
        }
    }

    _openJobPath(descriptor) {
        if (!descriptor)
            return;
        if (descriptor.kind === 'remote') {
            new RemoteBrowserDialog(this, {
                mode: 'browse',
                remote: descriptor.remote,
                path: descriptor.path || '',
            }).present();
            return;
        }
        let path;
        try {
            path = localPathFor(descriptor, this.volumes);
        } catch (e) {
            this.toast(e.message);
            return;
        }
        if (!path || !GLib.file_test(path, GLib.FileTest.EXISTS)) {
            this.toast(`Path not available: ${path || descriptor.path || ''}`);
            return;
        }
        try {
            this.launcher.openPath(path);
        } catch (e) {
            this.toast(e.message);
        }
    }

    openVersions(job) {
        new RestoreDialog(this, job).present();
    }

    confirm(title, body, destructive, callback) {
        const dialog = new Adw.AlertDialog({heading: title, body});
        dialog.add_response('cancel', 'Cancel');
        dialog.add_response('ok', destructive ? 'Delete' : 'Continue');
        dialog.set_response_appearance('ok', destructive
            ? Adw.ResponseAppearance.DESTRUCTIVE
            : Adw.ResponseAppearance.SUGGESTED);
        dialog.connect('response', (_dialog, response) => {
            if (response === 'ok')
                callback();
        });
        dialog.present(this);
    }
});
