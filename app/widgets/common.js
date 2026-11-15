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

export function makeStatusVisual(status = 'idle') {
    const stack = new Gtk.Stack({
        valign: Gtk.Align.CENTER,
        width_request: 18,
        height_request: 18,
    });
    const spinner = new Gtk.Spinner({
        spinning: false,
        width_request: 18,
        height_request: 18,
    });
    spinner.add_css_class('saveme-status-spinner');
    const icon = makeStatusIcon(status);
    stack.add_named(spinner, 'spinner');
    stack.add_named(icon, 'icon');
    stack._saveMeSpinner = spinner;
    stack._saveMeIcon = icon;
    setStatusVisual(stack, status);
    return stack;
}

export function setStatusVisual(stack, status, phase = null) {
    if (!stack)
        return;
    const active = status === 'running';
    const display = active
        ? phase === 'checking' ? 'checking' : 'running'
        : status || 'idle';
    stack._saveMeSpinner.spinning = active;
    for (const cssClass of [...stack._saveMeSpinner.get_css_classes()]) {
        if (cssClass.startsWith('saveme-status-spinner-'))
            stack._saveMeSpinner.remove_css_class(cssClass);
    }
    stack._saveMeSpinner.add_css_class(`saveme-status-spinner-${display}`);
    setStatusIcon(stack._saveMeIcon, display);
    stack.set_visible_child_name(active ? 'spinner' : 'icon');
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

export function iconButton(iconName, tooltip, {cssClasses = [], pixelSize = 20} = {}) {
    const button = new Gtk.Button({
        child: new Gtk.Image({icon_name: iconName, pixel_size: pixelSize}),
        css_classes: cssClasses,
        width_request: 38,
        height_request: 38,
        valign: Gtk.Align.CENTER,
    });
    button.set_tooltip_text(tooltip);
    button.set_accessible_name?.(tooltip);
    return button;
}
