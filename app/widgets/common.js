import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import {statusIconName} from '../presentation/format.js';
import {sanitizeLogText} from '../../src/domain/log-policy.js';

export function readTail(path, maxLines = 800) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok)
            return '';
        const lines = new TextDecoder().decode(bytes).split('\n');
        return sanitizeLogText(
            lines.slice(Math.max(0, lines.length - maxLines)).join('\n'));
    } catch (_) {
        return '';
    }
}

export function basenameOf(path) {
    return GLib.path_get_basename(String(path || ''));
}

export function setStatusIcon(icon, status) {
    icon.icon_name = statusIconName(status);
    for (const cssClass of [...icon.get_css_classes()]) {
        if (cssClass.startsWith('saveme-status-'))
            icon.remove_css_class(cssClass);
    }
    icon.add_css_class(`saveme-status-${status}`);
}

export function makeStatusIcon(status) {
    const icon = new Gtk.Image({
        icon_name: statusIconName(status),
        pixel_size: 16,
        valign: Gtk.Align.CENTER,
    });
    icon.add_css_class(`saveme-status-${status}`);
    return icon;
}

export function iconLabelButton(label, iconName, {cssClasses = [], tooltip = null} = {}) {
    const box = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
    });
    const icon = new Gtk.Image({icon_name: iconName, pixel_size: 16});
    const text = new Gtk.Label({label});
    box.append(icon);
    box.append(text);
    const button = new Gtk.Button({child: box, css_classes: cssClasses});
    if (tooltip)
        button.set_tooltip_text(tooltip);
    button._saveMeIcon = icon;
    button._saveMeLabel = text;
    return button;
}
