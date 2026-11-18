import GLib from 'gi://GLib';
import {SystemLauncher} from './gateway/system-launcher.js';

function rclonePath() {
    return GLib.getenv('SAVEME_RCLONE') ||
        GLib.find_program_in_path('rclone') ||
        '/usr/lib/saveme/bin/rclone';
}

function configPath() {
    return GLib.build_filenamev([
        GLib.get_user_config_dir(),
        'saveme',
        'rclone.conf',
    ]);
}

/**
 * Measure a destination folder without blocking the daemon's main loop.
 * Large cloud folders can take a long time to size, so this runs in the app
 * process and returns a Promise.
 */
export async function probeFolderSize(path) {
    const launcher = new SystemLauncher();
    const output = await launcher.capture([
        rclonePath(),
        '--config', configPath(),
        'size', path,
        '--json',
        '--fast-list',
    ]);
    return JSON.parse(output);
}
