import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {t} from '../../src/i18n.js';

export class AboutPage {
    constructor(_window) {
        this.widget = new Adw.PreferencesPage();
        const heroGroup = new Adw.PreferencesGroup();
        const hero = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 18,
            margin_top: 24,
            margin_bottom: 24,
            halign: Gtk.Align.CENTER,
            valign: Gtk.Align.CENTER,
        });
        hero.append(new Gtk.Image({
            icon_name: 'io.github.chrismaille.SaveMe',
            pixel_size: 96,
        }));
        const heroText = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            valign: Gtk.Align.CENTER,
        });
        const title = new Gtk.Label({
            label: 'SaveMe',
            xalign: 0,
            css_classes: ['title-1'],
        });
        const subtitle = new Gtk.Label({
            label: t('Sync and backup for GNOME'),
            xalign: 0,
            css_classes: ['dim-label'],
        });
        this.versionLabel = new Gtk.Label({
            label: '',
            xalign: 0,
            css_classes: ['dim-label'],
        });
        heroText.append(title);
        heroText.append(subtitle);
        heroText.append(this.versionLabel);
        hero.append(heroText);
        heroGroup.add(hero);
        this.widget.add(heroGroup);

        const aboutGroup = new Adw.PreferencesGroup({title: t('About')});
        this.versionRow = new Adw.ActionRow({title: t('Version'), subtitle: '-'});
        this.rcloneRow = new Adw.ActionRow({title: 'rclone', subtitle: '-'});
        aboutGroup.add(this.versionRow);
        aboutGroup.add(this.rcloneRow);
        this.widget.add(aboutGroup);

        const linksGroup = new Adw.PreferencesGroup({
            title: t('Links'),
            description: t('Project links will appear here in a future release.'),
        });
        linksGroup.add(new Adw.ActionRow({
            title: 'GitHub',
            subtitle: t('Coming soon'),
            sensitive: false,
        }));
        linksGroup.add(new Adw.ActionRow({
            title: 'Flatpak',
            subtitle: t('Coming soon'),
            sensitive: false,
        }));
        this.widget.add(linksGroup);
    }

    update(snapshot) {
        const version = snapshot.version || '-';
        this.versionLabel.set_text(version);
        this.versionRow.set_subtitle(version);
        const rclone = snapshot.daemon?.rclone;
        this.rcloneRow.set_subtitle(rclone
            ? `${rclone.version || 'unknown'} · ${rclone.path || '-'}`
            : 'unavailable');
    }
}
