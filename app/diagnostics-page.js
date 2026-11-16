import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {t} from '../src/i18n.js';

export class DiagnosticsPage {
    constructor(_window, logsPage, debugPage) {
        this.logsPage = logsPage;
        this.debugPage = debugPage;
        this.stack = new Adw.ViewStack();
        this.stack.add_titled(logsPage.widget, 'logs', t('Logs'))
            .set_icon_name('text-x-generic-symbolic');
        this.stack.add_titled(debugPage.widget, 'debug', t('Debug'))
            .set_icon_name('utilities-terminal-symbolic');
        this.switcher = new Adw.ViewSwitcher({
            stack: this.stack,
            policy: Adw.ViewSwitcherPolicy.WIDE,
        });
        const switcherBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            halign: Gtk.Align.CENTER,
            margin_top: 6,
            margin_bottom: 6,
        });
        switcherBox.append(this.switcher);
        this.widget = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        this.widget.append(switcherBox);
        this.widget.append(this.stack);
    }

    show(name = null) {
        if (name)
            this.stack.set_visible_child_name(name);
    }

    onShown(name = null) {
        this.show(name);
        if (!name || name === 'logs')
            this.logsPage.onShown();
        if (!name || name === 'debug')
            this.debugPage.onShown();
    }
}
