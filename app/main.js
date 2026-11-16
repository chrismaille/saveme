#!/usr/bin/env -S gjs -m

import system from 'system';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk?version=4.0';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {DaemonGateway} from './gateway/daemon-gateway.js';
import {JobEditor} from './job-editor.js';
import {AccountsDialog} from './accounts-dialog.js';
import {SyncSelectionDialog} from './sync-selection-dialog.js';
import {defaultJob} from '../src/jobs.js';
import {AppLog} from './observability/app-log.js';
import {AppMonitor} from './observability/app-monitor.js';
import {buildSoakSnapshot} from './observability/soak.js';
import {SaveMeWindow} from './window.js';

const APP_ID = 'io.github.chrismaille.SaveMe.Settings';
const APP_DIR = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);

const SaveMeApplication = GObject.registerClass({
    GTypeName: 'SaveMeSettingsApplication',
}, class SaveMeApplication extends Adw.Application {
    constructor() {
        super({
            application_id: APP_ID,
            flags: Gio.ApplicationFlags.HANDLES_COMMAND_LINE,
        });
        this._window = null;
        this._client = null;
        this._appLog = null;
        this._monitor = null;
        this._pendingView = null;
        this._pendingJob = null;
        this._smokeTest = false;
        this._soakTest = false;
        this._soakIterations = 0;
        this._smokeStarted = false;
        this._smokeChecks = 0;
        this._smokeResult = 1;
        this.connect('startup', () => this._startup());
        this.connect('activate', () => this._activate());
        this.connect('command-line', (_app, commandLine) => {
            this._parseCommandLine(commandLine);
            this.activate();
            return 0;
        });
        this.connect('shutdown', () => {
            this._monitor?.stop();
            this._monitor = null;
            this._appLog?.logger.info('App stopped');
            this._appLog?.close();
            this._appLog = null;
            this._client?.close();
            this._client = null;
        });
    }

    _startup() {
        this._loadCss();
        this._appLog = new AppLog();
        this._monitor = new AppMonitor({logger: this._appLog.logger});
        this._monitor.start();
        this._appLog.logger.info('App started');
        this._client = new DaemonGateway();
    }

    _loadCss() {
        try {
            const provider = new Gtk.CssProvider();
            provider.load_from_path(GLib.build_filenamev([APP_DIR, 'style.css']));
            Gtk.StyleContext.add_provider_for_display(
                Gdk.Display.get_default(),
                provider,
                Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
        } catch (e) {
            printerr(`SaveMe: cannot load CSS: ${e.message}`);
        }
    }

    _parseCommandLine(commandLine) {
        const args = commandLine.get_arguments().slice(1);
        for (let i = 0; i < args.length; i++) {
            if (args[i] === '--view')
                this._pendingView = args[++i];
            else if (args[i] === '--job')
                this._pendingJob = args[++i];
            else if (args[i] === '--smoke-test')
                this._smokeTest = true;
            else if (args[i] === '--soak-test') {
                this._smokeTest = true;
                this._soakTest = true;
            } else if (args[i] === '--soak-iterations')
                this._soakIterations = Math.max(1, Number(args[++i]) || 0);
        }
    }

    _activate() {
        if (!this._window) {
            this._window = new SaveMeWindow(this, this._client, {
                monitor: this._monitor,
                appLog: this._appLog,
            });
            this._window.connect('close-request', () => {
                this._window = null;
                return false;
            });
        }
        this._window.present();
        if (this._pendingView) {
            this._window.showView(this._pendingView, this._pendingJob);
            this._pendingView = null;
            this._pendingJob = null;
        }
        if (this._smokeTest && !this._smokeStarted) {
            this._smokeStarted = true;
            this._checkSmoke();
        }
    }

    get smokeRequested() {
        return this._smokeTest;
    }

    get smokeExitCode() {
        return this._smokeResult;
    }

    _checkSmoke() {
        if (!this._window) {
            this._failSmoke('window was not created');
            return;
        }
        const snapshot = this._window.snapshot;
        if (!snapshot) {
            this._smokeChecks++;
            if (this._smokeChecks > 100) {
                this._failSmoke('daemon snapshot was not received');
                return;
            }
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                this._checkSmoke();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        try {
            const editor = new JobEditor(this._window, null);
            editor.close();
            const backupEditor = new JobEditor(this._window, defaultJob({
                name: 'Smoke backup',
                type: 'backup',
                source: {kind: 'local', path: '/tmp/saveme-smoke'},
                destination: {kind: 'local', path: '/tmp/saveme-smoke-dest'},
                trigger: {mode: 'interval', intervalMinutes: 60},
            }));
            backupEditor.close();
            const draftEditor = new JobEditor(this._window, defaultJob({
                name: 'Smoke draft',
                type: 'backup',
                draft: true,
                draftStep: 3,
                enabled: false,
                source: {kind: 'local', path: '/tmp/saveme-smoke'},
                destination: {kind: 'local', path: '/tmp/saveme-smoke-dest'},
            }));
            if (draftEditor._step !== 3)
                throw new Error('draft did not resume at its saved step');
            draftEditor._saved = true;
            draftEditor.close();
            const accounts = new AccountsDialog(this._window, {provider: 'onedrive'});
            accounts.close();
            const selector = new SyncSelectionDialog(this._window, {
                rootPath: '/tmp',
                selected: [],
            });
            selector.close();
            for (const view of ['jobs', 'accounts', 'settings', 'diagnostics',
                'logs', 'debug', 'about'])
                this._window.showView(view);
        } catch (e) {
            this._failSmoke(`cannot show views: ${e.message}`);
            return;
        }
        print(`SaveMe app smoke: OK (jobs=${snapshot.jobs?.length || 0})`);
        if (!this._soakTest) {
            this._smokeResult = 0;
            this.quit();
            return;
        }
        this._runSoak(snapshot).catch(e => this._failSmoke(`soak failed: ${e.message}`));
    }

    _wait(ms) {
        return new Promise(resolve => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    async _runSoak(snapshot) {
        const before = this._monitor?.sampleNow('soak-before');
        const iterations = this._soakIterations ||
            Math.max(1, Number(GLib.getenv('SAVEME_SOAK_ITERATIONS') || 120));
        this._appLog?.logger.info('Memory soak starting', {iterations});
        for (let index = 0; index < iterations; index++) {
            this._window._applySnapshot(buildSoakSnapshot(snapshot, index));
            if (index % 20 === 0)
                await this._wait(0);
        }
        await this._wait(250);
        system.gc?.();
        await this._wait(250);
        const after = this._monitor?.sampleNow('soak-after');
        if (!before || !after) {
            this._failSmoke('performance metrics unavailable during soak');
            return;
        }
        const delta = after.rssBytes - before.rssBytes;
        const limitMb = Math.max(1,
            Number(GLib.getenv('SAVEME_SOAK_MAX_RSS_DELTA_MB') || 64));
        const limit = limitMb * 1024 * 1024;
        const absoluteLimitMb = Math.max(1,
            Number(GLib.getenv('SAVEME_SOAK_MAX_RSS_MB') || 512));
        const absoluteLimit = absoluteLimitMb * 1024 * 1024;
        this._appLog?.logger.info('Memory soak finished', {
            iterations,
            rssDeltaMiB: Number((delta / (1024 * 1024)).toFixed(1)),
            rssMiB: Number((after.rssBytes / (1024 * 1024)).toFixed(1)),
            limitMiB: limitMb,
            absoluteLimitMiB: absoluteLimitMb,
        });
        if (after.rssBytes > absoluteLimit) {
            this._failSmoke(
                `memory reached ${(after.rssBytes / (1024 * 1024)).toFixed(1)} MiB ` +
                `(absolute limit ${absoluteLimitMb} MiB)`);
            return;
        }
        if (delta > limit) {
            this._failSmoke(
                `memory grew ${(delta / (1024 * 1024)).toFixed(1)} MiB ` +
                `(limit ${limitMb} MiB)`);
            return;
        }
        print(`SaveMe app soak: OK (rssDelta=${(delta / (1024 * 1024)).toFixed(1)} MiB, ` +
            `rss=${(after.rssBytes / (1024 * 1024)).toFixed(1)} MiB, ` +
            `limit=${limitMb} MiB)`);
        this._smokeResult = 0;
        this.quit();
    }

    _failSmoke(message) {
        this._smokeResult = 1;
        this._appLog?.logger.error(`App smoke failed: ${message}`);
        printerr(`SaveMe app smoke: ${message}`);
        this.quit();
    }
});

try {
    const app = new SaveMeApplication();
    const status = app.run([system.programInvocationName, ...system.programArgs]);
    system.exit(app.smokeRequested ? app.smokeExitCode : status);
} catch (e) {
    printerr(`saveme-settings: ${e.message}`);
    if (e.stack)
        printerr(e.stack);
    system.exit(1);
}
