import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';

export const LogDialog = GObject.registerClass({
    GTypeName: 'SaveMeLogDialog',
}, class LogDialog extends Adw.Window {
    constructor(parent, title, text) {
        super({
            transient_for: parent,
            modal: true,
            title,
            default_width: 820,
            default_height: 600,
        });

        const toolbar = new Adw.ToolbarView();
        const header = new Adw.HeaderBar();
        header.set_title_widget(new Adw.WindowTitle({title}));
        const copyButton = new Gtk.Button({
            icon_name: 'edit-copy-symbolic',
            tooltip_text: 'Copy',
            css_classes: ['flat'],
        });
        copyButton.connect('clicked', () => {
            try {
                parent.get_clipboard().set(text || '');
            } catch (_) {
                // Ignore clipboard errors.
            }
        });
        header.pack_end(copyButton);
        toolbar.add_top_bar(header);

        const scrolled = new Gtk.ScrolledWindow({
            vexpand: true,
            hexpand: true,
        });
        const view = new Gtk.TextView({
            editable: false,
            monospace: true,
            wrap_mode: Gtk.WrapMode.NONE,
            left_margin: 10,
            right_margin: 10,
            top_margin: 10,
            bottom_margin: 10,
        });
        view.add_css_class('saveme-log-view');
        view.get_buffer().set_text(text || '', -1);
        scrolled.set_child(view);
        toolbar.set_content(scrolled);
        this.set_content(toolbar);
    }
});
