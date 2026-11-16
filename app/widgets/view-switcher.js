import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';

/**
 * A view switcher whose icon always sits beside the label. AdwViewSwitcher
 * stacks the icon above the label in wide mode, so SaveMe uses an
 * AdwToggleGroup with custom toggle contents instead.
 */
export function createIconViewSwitcher(stack, items) {
    const group = new Adw.ToggleGroup({
        homogeneous: true,
        can_shrink: true,
        css_classes: ['saveme-view-switcher'],
    });
    for (const item of items) {
        const content = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
        });
        content.append(new Gtk.Image({
            icon_name: item.icon,
            pixel_size: 16,
        }));
        content.append(new Gtk.Label({label: item.title}));
        group.add(new Adw.Toggle({
            name: item.name,
            child: content,
            tooltip: item.title,
        }));
    }
    let syncing = false;
    group.connect('notify::active-name', () => {
        if (syncing)
            return;
        const name = group.active_name;
        if (name)
            stack.set_visible_child_name(name);
    });
    stack.connect('notify::visible-child', () => {
        syncing = true;
        group.active_name = stack.visible_child_name;
        syncing = false;
    });
    group.active_name = stack.visible_child_name || items[0]?.name || '';
    return group;
}
