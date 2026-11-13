import GLib from 'gi://GLib';

export const APP_ID = 'io.github.chrismaille.SaveMe';
export const SETTINGS_APP_ID = 'io.github.chrismaille.SaveMe.Settings';
export const DAEMON_APP_ID = 'io.github.chrismaille.SaveMe.Daemon';
export const DAEMON_BUS_NAME = 'io.github.chrismaille.SaveMe.Daemon';
export const DAEMON_INTERFACE = 'io.github.chrismaille.SaveMe.Daemon';
export const DAEMON_OBJECT_PATH = '/io/github/chrismaille/SaveMe/Daemon';
export const EXTENSION_UUID = 'saveme@chrismaille.github.io';
export const GETTEXT_DOMAIN = 'saveme';

export function configDir() {
    return GLib.build_filenamev([GLib.get_user_config_dir(), 'saveme']);
}

export function stateDir() {
    return GLib.build_filenamev([GLib.get_user_state_dir(), 'saveme']);
}

export function cacheDir() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'saveme']);
}

export function runtimeDir() {
    const base = GLib.getenv('XDG_RUNTIME_DIR') || GLib.get_tmp_dir();
    return GLib.build_filenamev([base, 'saveme']);
}

export function configFile() {
    return GLib.build_filenamev([configDir(), 'config.json']);
}

export function configBackupFile() {
    return GLib.build_filenamev([configDir(), 'config.json.bak']);
}

export function rcloneConfigFile() {
    return GLib.build_filenamev([configDir(), 'rclone.conf']);
}

export function stateFile() {
    return GLib.build_filenamev([stateDir(), 'state.json']);
}

export function runsDir(jobId = null) {
    const base = GLib.build_filenamev([stateDir(), 'runs']);
    return jobId ? GLib.build_filenamev([base, jobId]) : base;
}

export function logsDir(jobId = null) {
    const base = GLib.build_filenamev([stateDir(), 'logs']);
    return jobId ? GLib.build_filenamev([base, jobId]) : base;
}

export function filtersDir() {
    return GLib.build_filenamev([stateDir(), 'filters']);
}

export function tmpDir() {
    return GLib.build_filenamev([stateDir(), 'tmp']);
}

export function bundledRclone() {
    return '/usr/lib/saveme/bin/rclone';
}

export function projectRclone() {
    return GLib.build_filenamev([GLib.get_current_dir(), 'tools', 'rclone']);
}

export function settingsDesktopFile() {
    return `${SETTINGS_APP_ID}.desktop`;
}

export function daemonServiceFile() {
    return `${DAEMON_BUS_NAME}.service`;
}
