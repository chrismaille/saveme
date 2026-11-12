#!/usr/bin/env -S gjs -m

import system from 'system';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gdk from 'gi://Gdk?version=4.0';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {DaemonClient} from './daemon-client.js';
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
        this._pendingView = null;
        this._pendingJob = null;
        this.connect('startup', () => this._startup());
        this.connect('activate', () => this._activate());
        this.connect('command-line', (_app, commandLine) => {
            this._parseCommandLine(commandLine);
            this.activate();
            return 0;
        });
        this.connect('shutdown', () => {
            this._client?.close();
            this._client = null;
        });
    }

    _startup() {
        this._loadCss();
        this._client = new DaemonClient();
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
        }
    }

    _activate() {
        if (!this._window) {
            this._window = new SaveMeWindow(this, this._client);
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
    }
});

try {
    const app = new SaveMeApplication();
    system.exit(app.run([system.programInvocationName, ...system.programArgs]));
} catch (e) {
    printerr(`saveme-settings: ${e.message}`);
    if (e.stack)
        printerr(e.stack);
    system.exit(1);
}
