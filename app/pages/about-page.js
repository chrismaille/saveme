import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import {t} from '../../src/i18n.js';

export class AboutPage {
    constructor(window) {
        this.window = window;
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
            icon_name: GLib.getenv('SAVEME_ICON_NAME') ||
                'io.github.chrismaille.SaveMe',
            pixel_size: 96,
        }));
        const heroText = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            valign: Gtk.Align.CENTER,
        });
        const title = new Gtk.Label({
            label: GLib.getenv('SAVEME_APP_TITLE') || 'SaveMe',
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
        aboutGroup.add(this.versionRow);
        this.widget.add(aboutGroup);

        const linksGroup = new Adw.PreferencesGroup({
            title: t('Links'),
            description: t('Project source and releases.'),
        });
        const github = new Adw.ActionRow({
            title: 'GitHub',
            subtitle: 'chrismaille/saveme',
            activatable: true,
        });
        github.add_suffix(new Gtk.Image({
            icon_name: 'adw-external-link-symbolic',
            pixel_size: 16,
        }));
        github.connect('activated', () => this.window.launcher.openUri(
            'https://github.com/chrismaille/saveme'));
        linksGroup.add(github);
        this.widget.add(linksGroup);
    }

    update(snapshot) {
        const version = snapshot.version || '-';
        this.versionLabel.set_text(version);
        this.versionRow.set_subtitle(version);
    }
}
