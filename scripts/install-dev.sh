#!/bin/sh
# Install an isolated development build of SaveMe.
#
# The development build never touches the production package, configuration,
# state, daemon, desktop entries or GNOME extension. It uses its own app ID,
# D-Bus name, config/state directories, binaries and extension UUID.
#
# Run as your desktop user, not with sudo.
#
#   ./scripts/install-dev.sh
#   ./scripts/install-dev.sh --no-start
#   ./scripts/install-dev.sh --uninstall --yes
#   ./scripts/install-dev.sh --uninstall --purge --yes

set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

APP_ID="io.github.chrismaille.SaveMe.Dev.Settings"
DAEMON_ID="io.github.chrismaille.SaveMe.Dev.Daemon"
DAEMON_OBJECT="/io/github/chrismaille/SaveMe/Dev/Daemon"
EXTENSION_UUID="saveme-dev@chrismaille.github.io"
ICON_NAME="io.github.chrismaille.SaveMe.Dev"
UNIT_NAME="saveme-dev.service"

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"

PREFIX="${SAVEME_DEV_PREFIX:-$DATA_HOME/saveme-dev}"
BIN_DIR="${SAVEME_DEV_BIN_DIR:-$HOME/.local/bin}"
CONFIG_DIR="${SAVEME_DEV_CONFIG_DIR:-$CONFIG_HOME/saveme-dev}"
STATE_DIR="${SAVEME_DEV_STATE_DIR:-$STATE_HOME/saveme-dev}"
CACHE_DIR="${SAVEME_DEV_CACHE_DIR:-$CACHE_HOME/saveme-dev}"
RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp}/saveme-dev"

EXTENSION_DIR="$DATA_HOME/gnome-shell/extensions/$EXTENSION_UUID"
SYSTEMD_DIR="$CONFIG_HOME/systemd/user"
DBUS_DIR="$DATA_HOME/dbus-1/services"
APPLICATIONS_DIR="$DATA_HOME/applications"
ICONS_DIR="$DATA_HOME/icons/hicolor/256x256/apps"
AUTOSTART_DIR="$CONFIG_HOME/autostart"

ACTION="install"
PURGE=0
YES=0
NO_START=0
RELOAD_EXTENSION=0
DRY_RUN=0

usage() {
    cat <<EOF
SaveMe development installer

Usage:
  install-dev.sh [options]
  install-dev.sh --uninstall [options]

Installs an isolated development build in:
  $PREFIX

The production SaveMe package and its configuration are not touched.

Options:
  --uninstall    Remove the development build
  --purge        With --uninstall: also remove dev config, state and cache
  --yes          Do not ask for confirmation on uninstall
  --no-start          Install the daemon service but do not start it
  --reload-extension  Reload the GNOME extension after updating it
                     (the Shell can pause briefly while it reloads)
  --dry-run           Show the plan without changing anything
  -h, --help     Show this help

Environment overrides:
  SAVEME_DEV_PREFIX, SAVEME_DEV_BIN_DIR, SAVEME_DEV_CONFIG_DIR,
  SAVEME_DEV_STATE_DIR, SAVEME_DEV_CACHE_DIR, SAVEME_RCLONE
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --uninstall) ACTION="uninstall"; shift ;;
        --purge) PURGE=1; shift ;;
        --yes|-y) YES=1; shift ;;
        --no-start) NO_START=1; shift ;;
        --reload-extension) RELOAD_EXTENSION=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        --help|-h) usage; exit 0 ;;
        *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
    esac
done

if [ "$PURGE" -eq 1 ] && [ "$ACTION" != "uninstall" ]; then
    echo "--purge is only valid with --uninstall." >&2
    exit 1
fi

say() {
    printf '%s\n' "$*"
}

with_timeout() {
    seconds="$1"
    shift
    if command -v timeout >/dev/null 2>&1; then
        timeout "$seconds" "$@"
    else
        "$@"
    fi
}

run() {
    if [ "$DRY_RUN" -eq 1 ]; then
        say "+ $*"
        return 0
    fi
    say "+ $*"
    started="$(date +%s)"
    if "$@"; then
        status=0
    else
        status=$?
    fi
    elapsed=$(( $(date +%s) - started ))
    if [ "$elapsed" -ge 3 ]; then
        say "  ↳ took ${elapsed}s"
    fi
    return "$status"
}

write_file() {
    path="$1"
    if [ "$DRY_RUN" -eq 1 ]; then
        say "+ write $path"
        cat >/dev/null
        return 0
    fi
    mkdir -p "$(dirname "$path")"
    cat > "$path"
}

has_user_systemd() {
    command -v systemctl >/dev/null 2>&1 &&
        systemctl --user show-environment >/dev/null 2>&1
}

extension_enabled() {
    command -v gnome-extensions >/dev/null 2>&1 &&
        gnome-extensions list --enabled 2>/dev/null |
            grep -qx "$EXTENSION_UUID"
}

stop_dev_daemon() {
    if [ "${SAVEME_DEV_SKIP_SYSTEMD:-0}" != 1 ] && has_user_systemd; then
        run with_timeout 15 systemctl --user stop "$UNIT_NAME" \
            >/dev/null 2>&1 || true
    fi
    run pkill -TERM -f "$PREFIX/bin/saveme-daemon.js" >/dev/null 2>&1 || true
}

uninstall_dev() {
    if [ "$YES" -ne 1 ]; then
        printf 'Remove SaveMe Dev from %s? [y/N] ' "$PREFIX"
        answer=""
        read -r answer || true
        case "$answer" in
            y|Y|yes|YES) ;;
            *) say "Cancelled."; exit 0 ;;
        esac
    fi

    say "Removing SaveMe Dev (production installation untouched)…"
    stop_dev_daemon

    if [ "${SAVEME_DEV_SKIP_SYSTEMD:-0}" != 1 ] && has_user_systemd; then
        run systemctl --user disable "$UNIT_NAME" >/dev/null 2>&1 || true
    fi
    run rm -f "$SYSTEMD_DIR/$UNIT_NAME"
    run rm -f "$DBUS_DIR/$DAEMON_ID.service"
    run rm -f "$APPLICATIONS_DIR/$APP_ID.desktop"
    run rm -f "$AUTOSTART_DIR/saveme-dev-daemon.desktop"
    run rm -f "$ICONS_DIR/$ICON_NAME.png"

    if command -v gnome-extensions >/dev/null 2>&1; then
        run gnome-extensions uninstall "$EXTENSION_UUID" >/dev/null 2>&1 || true
    fi
    run rm -rf "$EXTENSION_DIR"

    for wrapper in saveme-dev saveme-dev-daemon saveme-dev-settings; do
        run rm -f "$BIN_DIR/$wrapper"
    done
    run rm -rf "$PREFIX"

    if [ "${SAVEME_DEV_SKIP_SYSTEMD:-0}" != 1 ] && has_user_systemd; then
        run with_timeout 10 systemctl --user daemon-reload >/dev/null 2>&1 || true
    fi
    if command -v update-desktop-database >/dev/null 2>&1; then
        run with_timeout 20 update-desktop-database "$APPLICATIONS_DIR" \
            >/dev/null 2>&1 || true
    fi
    if command -v gtk-update-icon-cache >/dev/null 2>&1; then
        run with_timeout 20 gtk-update-icon-cache -f -t "$DATA_HOME/icons/hicolor" \
            >/dev/null 2>&1 || true
    fi

    if [ "$PURGE" -eq 1 ]; then
        run rm -rf "$CONFIG_DIR" "$STATE_DIR" "$CACHE_DIR" "$RUNTIME_DIR"
        say "Development configuration, state and cache removed."
    else
        say "Development configuration and state were kept:"
        say "  $CONFIG_DIR"
        say "  $STATE_DIR"
        say "Use --purge to remove them."
    fi
    say "SaveMe Dev removed."
    exit 0
}

if [ "$ACTION" = "uninstall" ]; then
    uninstall_dev
fi

if [ "$(id -u)" -eq 0 ]; then
    echo "Run this script as your desktop user, not with sudo." >&2
    echo "It installs only inside your home directory." >&2
    exit 1
fi

if ! command -v gjs >/dev/null 2>&1; then
    echo "gjs is required. Install the GJS runtime first." >&2
    exit 1
fi
if ! command -v zip >/dev/null 2>&1; then
    echo "zip is required to package the development GNOME extension." >&2
    exit 1
fi

if [ "$PREFIX" = "$DATA_HOME/saveme" ] ||
    [ "$CONFIG_DIR" = "$CONFIG_HOME/saveme" ] ||
    [ "$STATE_DIR" = "$STATE_HOME/saveme" ] ||
    [ "$CACHE_DIR" = "$CACHE_HOME/saveme" ]; then
    echo "Refusing to use a production SaveMe path for the development build." >&2
    exit 1
fi

RCLONE="${SAVEME_RCLONE:-$ROOT_DIR/tools/rclone}"
if [ ! -x "$RCLONE" ]; then
    RCLONE="$(command -v rclone || true)"
fi
if [ -z "$RCLONE" ] || [ ! -x "$RCLONE" ]; then
    echo "rclone not found. Run 'make setup' or set SAVEME_RCLONE." >&2
    exit 1
fi

say "SaveMe Dev install"
say "  source:     $ROOT_DIR"
say "  prefix:     $PREFIX"
say "  app ID:     $APP_ID"
say "  daemon:     $DAEMON_ID"
say "  extension:  $EXTENSION_UUID"
say "  config:     $CONFIG_DIR"
say "  state:      $STATE_DIR"
say "  production: untouched"
say ""
say "Stopping SaveMe Dev. Running jobs are interrupted and resume when the daemon"
say "starts again. The daemon restart is needed to load the new code."

stop_dev_daemon

run rm -rf "$PREFIX"
run mkdir -p "$PREFIX/app" "$PREFIX/src" "$PREFIX/bin" "$PREFIX/assets"
run mkdir -p "$BIN_DIR" "$SYSTEMD_DIR" "$DBUS_DIR" "$APPLICATIONS_DIR"
run mkdir -p "$ICONS_DIR" "$AUTOSTART_DIR"

run cp -a "$ROOT_DIR/app/." "$PREFIX/app/"
run cp -a "$ROOT_DIR/src/." "$PREFIX/src/"
run cp -a "$ROOT_DIR/bin/." "$PREFIX/bin/"
run cp -a "$ROOT_DIR/assets/." "$PREFIX/assets/"
run ln -sfn "$RCLONE" "$PREFIX/rclone"
DEV_ICON="$ROOT_DIR/assets/saveme-dev.png"
if [ ! -f "$DEV_ICON" ]; then
    DEV_ICON="$ROOT_DIR/assets/icon.png"
fi
run cp "$DEV_ICON" "$ICONS_DIR/$ICON_NAME.png"

run mkdir -p "$PREFIX/extension"
run cp -a "$ROOT_DIR/extension/." "$PREFIX/extension/"
run cp "$DEV_ICON" "$PREFIX/extension/icons/saveme-dev.png"
if [ "$DRY_RUN" -eq 0 ]; then
    {
        printf '%s\n' '// Generated from src/i18n.js by make extension. Do not edit.'
        cat "$ROOT_DIR/src/i18n.js"
    } > "$PREFIX/extension/i18n.js"
    sed -i "s|saveme@chrismaille\.github\.io|$EXTENSION_UUID|g" \
        "$PREFIX/extension/metadata.json"
    sed -i "s|\"name\": \"SaveMe\"|\"name\": \"SaveMe Dev\"|" \
        "$PREFIX/extension/metadata.json"
    sed -i "s|\"name\": \"SaveMe Dev\",|\"name\": \"SaveMe Dev\",\n  \"dev\": true,|" \
        "$PREFIX/extension/metadata.json"
    sed -i "s|\"description\": \"Source to destination: real-time sync and versioned backups.\"|\"description\": \"Development build of SaveMe: real-time sync and versioned backups.\"|" \
        "$PREFIX/extension/metadata.json"
    sed -i "s|icons/saveme-symbolic.svg|icons/saveme-dev.png|g" \
        "$PREFIX/extension/extension.js"
    sed -i "s|t('Open SaveMe')|t('Open SaveMe Dev')|g" \
        "$PREFIX/extension/extension.js"
    sed -i "s|'saveme-settings'|'$BIN_DIR/saveme-dev-settings'|g" \
        "$PREFIX/extension/extension.js"
    sed -i "s|io\.github\.chrismaille\.SaveMe\.Daemon|$DAEMON_ID|g" \
        "$PREFIX/extension/daemon-client.js"
    sed -i "s|/io/github/chrismaille/SaveMe/Daemon|$DAEMON_OBJECT|g" \
        "$PREFIX/extension/daemon-client.js"
    rm -f "$PREFIX/extension.zip"
    (cd "$PREFIX/extension" && zip -qr "$PREFIX/extension.zip" .)
else
    say "+ generate $PREFIX/extension/i18n.js"
    say "+ patch $PREFIX/extension metadata and D-Bus names"
    say "+ zip -qr $PREFIX/extension.zip (from $PREFIX/extension)"
fi

write_file "$PREFIX/env.sh" <<EOF
# Generated by scripts/install-dev.sh. Do not edit.
export SAVEME_DEV_BUILD="1"
export XDG_DATA_HOME="$DATA_HOME"
export XDG_CONFIG_HOME="$CONFIG_HOME"
export XDG_STATE_HOME="$STATE_HOME"
export XDG_CACHE_HOME="$CACHE_HOME"
export SAVEME_APP_ID="$APP_ID"
export SAVEME_APP_TITLE="SaveMe Dev"
export SAVEME_APP_NAME="SaveMe Dev"
export SAVEME_APP_MAIN="$PREFIX/app/main.js"
export SAVEME_ICON_NAME="$ICON_NAME"
export SAVEME_DAEMON_APP_ID="$DAEMON_ID"
export SAVEME_DAEMON_BUS_NAME="$DAEMON_ID"
export SAVEME_DAEMON_INTERFACE="$DAEMON_ID"
export SAVEME_DAEMON_OBJECT_PATH="$DAEMON_OBJECT"
export SAVEME_DAEMON_PROGRAM="$BIN_DIR/saveme-dev-daemon"
export SAVEME_DAEMON_SERVICE="$UNIT_NAME"
export SAVEME_SETTINGS_PROGRAM="$BIN_DIR/saveme-dev-settings"
export SAVEME_CONFIG_DIR="$CONFIG_DIR"
export SAVEME_STATE_DIR="$STATE_DIR"
export SAVEME_CACHE_DIR="$CACHE_DIR"
export SAVEME_RUNTIME_DIR="$RUNTIME_DIR"
export SAVEME_EXTENSION_UUID="$EXTENSION_UUID"
export SAVEME_EXTENSION_ZIP="$PREFIX/extension.zip"
export SAVEME_RCLONE="$PREFIX/rclone"
export SAVEME_BUNDLED_RCLONE="$PREFIX/rclone"
EOF

write_file "$BIN_DIR/saveme-dev" <<EOF
#!/bin/sh
. "$PREFIX/env.sh"
if [ "\$#" -eq 0 ]; then
    exec gjs -m "$PREFIX/app/main.js"
fi
exec gjs -m "$PREFIX/bin/saveme.js" "\$@"
EOF
write_file "$BIN_DIR/saveme-dev-settings" <<EOF
#!/bin/sh
. "$PREFIX/env.sh"
exec gjs -m "$PREFIX/app/main.js" "\$@"
EOF
write_file "$BIN_DIR/saveme-dev-daemon" <<EOF
#!/bin/sh
. "$PREFIX/env.sh"
exec gjs -m "$PREFIX/bin/saveme-daemon.js" "\$@"
EOF
if [ "$DRY_RUN" -eq 0 ]; then
    chmod 755 "$BIN_DIR/saveme-dev" "$BIN_DIR/saveme-dev-settings" \
        "$BIN_DIR/saveme-dev-daemon"
else
    say "+ chmod 755 $BIN_DIR/saveme-dev $BIN_DIR/saveme-dev-settings $BIN_DIR/saveme-dev-daemon"
fi

write_file "$SYSTEMD_DIR/$UNIT_NAME" <<EOF
[Unit]
Description=SaveMe Dev sync and backup daemon
Documentation=https://github.com/chrismaille/saveme
After=graphical-session.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=dbus
BusName=$DAEMON_ID
ExecStart=$BIN_DIR/saveme-dev-daemon
TimeoutStopSec=10
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF

write_file "$DBUS_DIR/$DAEMON_ID.service" <<EOF
[D-BUS Service]
Name=$DAEMON_ID
Exec=$BIN_DIR/saveme-dev-daemon
EOF

write_file "$APPLICATIONS_DIR/$APP_ID.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=SaveMe Dev
GenericName=Sync and Backup (development)
Comment=Isolated development build of SaveMe
Exec=$BIN_DIR/saveme-dev
TryExec=$BIN_DIR/saveme-dev
Icon=$ICON_NAME
Terminal=false
Categories=Utility;FileTools;
Keywords=sync;backup;cloud;drive;dropbox;onedrive;
StartupNotify=true
EOF

write_file "$AUTOSTART_DIR/saveme-dev-daemon.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=SaveMe Dev Daemon
Comment=Start the SaveMe Dev background daemon at login
Exec=$BIN_DIR/saveme-dev-daemon
Icon=$ICON_NAME
NoDisplay=true
X-GNOME-Autostart-enabled=true
EOF

if [ "${SAVEME_DEV_SKIP_SYSTEMD:-0}" != 1 ] && has_user_systemd; then
    run with_timeout 10 systemctl --user daemon-reload >/dev/null 2>&1 || true
fi

if command -v update-desktop-database >/dev/null 2>&1; then
    run with_timeout 20 update-desktop-database "$APPLICATIONS_DIR" \
        >/dev/null 2>&1 || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    run with_timeout 20 gtk-update-icon-cache -f -t "$DATA_HOME/icons/hicolor" \
        >/dev/null 2>&1 || true
fi

if [ "${SAVEME_DEV_SKIP_EXTENSION:-0}" = 1 ]; then
    say "GNOME extension install skipped (SAVEME_DEV_SKIP_EXTENSION=1)."
elif command -v gnome-extensions >/dev/null 2>&1; then
    if [ "$DRY_RUN" -eq 1 ]; then
        say "+ with_timeout 20 gnome-extensions install --force $PREFIX/extension.zip"
        if [ "$RELOAD_EXTENSION" -eq 1 ]; then
            say "+ with_timeout 10 gnome-extensions disable $EXTENSION_UUID"
            say "+ with_timeout 10 gnome-extensions enable $EXTENSION_UUID"
        elif extension_enabled; then
            say "+ extension already enabled; no reload"
        else
            say "+ with_timeout 10 gnome-extensions enable $EXTENSION_UUID"
        fi
    else
        if ! with_timeout 20 gnome-extensions install --force "$PREFIX/extension.zip"; then
            say "Could not install the development GNOME extension now."
            say "To open SaveMe Dev, use: $BIN_DIR/saveme-dev"
        elif [ "$RELOAD_EXTENSION" -eq 1 ]; then
            say "Reloading the GNOME extension; the Shell can pause briefly…"
            with_timeout 10 gnome-extensions disable "$EXTENSION_UUID" \
                >/dev/null 2>&1 || true
            with_timeout 10 gnome-extensions enable "$EXTENSION_UUID" \
                >/dev/null 2>&1 || true
        elif extension_enabled; then
            say "Extension files updated. The running panel keeps the old version;"
            say "use --reload-extension or log out and back in to load it."
        else
            with_timeout 10 gnome-extensions enable "$EXTENSION_UUID" \
                >/dev/null 2>&1 || true
        fi
    fi
else
    say "gnome-extensions is unavailable; the app will try to install it on first launch."
fi

if [ "$NO_START" -eq 1 ]; then
    say "Daemon not started (--no-start)."
elif [ "${SAVEME_DEV_SKIP_SYSTEMD:-0}" = 1 ] || ! has_user_systemd; then
    if [ "$DRY_RUN" -eq 1 ]; then
        say "+ $BIN_DIR/saveme-dev-daemon &"
    else
        mkdir -p "$STATE_DIR"
        nohup "$BIN_DIR/saveme-dev-daemon" >"$STATE_DIR/daemon.stdout.log" 2>&1 &
        say "Daemon started in the background (PID $!)."
    fi
elif ! run with_timeout 20 systemctl --user enable --now "$UNIT_NAME"; then
    say "The systemd user service could not be started."
    if [ "$DRY_RUN" -eq 0 ]; then
        mkdir -p "$STATE_DIR"
        nohup "$BIN_DIR/saveme-dev-daemon" >"$STATE_DIR/daemon.stdout.log" 2>&1 &
        say "Daemon started in the background (PID $!)."
    fi
else
    say "Daemon service enabled: $UNIT_NAME"
fi

if [ "$DRY_RUN" -eq 1 ]; then
    say "SaveMe Dev dry run complete. Nothing was changed."
else
    say "SaveMe Dev installed."
fi

cat <<EOF

  App:        saveme-dev (or "SaveMe Dev" in the app menu)
  Daemon:     systemctl --user status $UNIT_NAME
  Config:     $CONFIG_DIR
  State:      $STATE_DIR
  Extension:  $EXTENSION_UUID
  Production: untouched

Uninstall the development build with:
  ./scripts/install-dev.sh --uninstall --yes
EOF
