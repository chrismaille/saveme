#!/bin/sh
# SaveMe installer / updater / uninstaller.
#
# Local checkout:
#   ./scripts/install.sh                  # install or update
#   ./scripts/install.sh --uninstall --purge --yes
#
# Published:
#   curl -fsSL https://raw.githubusercontent.com/chrismaille/save_me/master/scripts/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/chrismaille/save_me/master/scripts/install.sh | sh -s -- --uninstall --purge --yes
#
# Run as your desktop user, not with sudo. The script calls sudo only for apt.

set -eu

ORIGINAL_ARGS="$*"
REPO="${SAVEME_REPO:-chrismaille/save_me}"
UUID="saveme@chrismaille.github.io"
ACTION="install"
PURGE=0
YES=0
DRY_RUN=0
WITH_EXTENSION=0
START_DAEMON=1
FORCE_REMOTE=0
VERSION=""
DEB_OVERRIDE=""
EXT_OVERRIDE=""
LOG_OVERRIDE=""
LOG_FILE=""
DAEMON_MASKED=0
EXITING=0
REMOVE_LOG_ON_EXIT=0

usage() {
    cat <<EOF
SaveMe installer

Usage:
  install.sh [options]
  install.sh --uninstall [options]

The default action installs or updates SaveMe automatically. User data is
preserved. Use --uninstall to remove it.

Options:
  --purge              With --uninstall: also remove config, tokens, logs and history
  --yes                Do not prompt for confirmation
  --dry-run            Print the plan without changing anything
  --with-extension     Install/update the GNOME Shell extension (optional)
  --no-extension       Do not install or update the GNOME Shell extension
  --app-only           Alias for --no-extension (default)
  --no-start           Do not start the daemon after installation
  --version VERSION    Install a specific release (e.g. 1.0.0)
  --deb PATH           Use a local .deb
  --extension PATH     Use a local extension zip (implies extension)
  --repo OWNER/REPO    GitHub repository (default: $REPO)
  --remote             Download artifacts even if a local dist/ exists
  --log PATH           Write the installation log to PATH
  -h, --help           Show this help

Examples:
  ./scripts/install.sh
  ./scripts/install.sh --with-extension
  ./scripts/install.sh --dry-run
  ./scripts/install.sh --uninstall --purge --yes
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --uninstall) ACTION="uninstall"; shift ;;
        --purge) PURGE=1; shift ;;
        --yes|-y) YES=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        --no-extension|--app-only) WITH_EXTENSION=0; shift ;;
        --with-extension) WITH_EXTENSION=1; shift ;;
        --no-start) START_DAEMON=0; shift ;;
        --remote) FORCE_REMOTE=1; shift ;;
        --version) VERSION="${2:-}"; shift 2 ;;
        --deb) DEB_OVERRIDE="${2:-}"; shift 2 ;;
        --extension) EXT_OVERRIDE="${2:-}"; WITH_EXTENSION=1; shift 2 ;;
        --repo) REPO="${2:-}"; shift 2 ;;
        --log) LOG_OVERRIDE="${2:-}"; shift 2 ;;
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
    if [ -n "$LOG_FILE" ]; then
        printf '%s\n' "$*" >> "$LOG_FILE" 2>/dev/null || true
    fi
}

run() {
    if [ "$DRY_RUN" -eq 1 ]; then
        say "+ $*"
        return 0
    fi
    say "+ $*"
    tmp="$(mktemp)"
    "$@" >"$tmp" 2>&1
    status=$?
    if [ -s "$tmp" ]; then
        cat "$tmp" | tee -a "$LOG_FILE"
    fi
    rm -f "$tmp"
    return $status
}

run_sudo() {
    if [ "$DRY_RUN" -eq 1 ]; then
        say "+ sudo $*"
        return 0
    fi
    say "+ sudo $*"
    tmp="$(mktemp)"
    # The temp file belongs to the unprivileged user; sudo only runs the command.
    # shellcheck disable=SC2024
    sudo "$@" >"$tmp" 2>&1
    status=$?
    if [ -s "$tmp" ]; then
        cat "$tmp" | tee -a "$LOG_FILE"
    fi
    rm -f "$tmp"
    return $status
}

mask_daemon() {
    if command -v systemctl >/dev/null 2>&1 &&
        systemctl --user show-environment >/dev/null 2>&1; then
        if run systemctl --user mask saveme.service >/dev/null 2>&1; then
            DAEMON_MASKED=1
        fi
    fi
}

unmask_daemon() {
    if [ "$DAEMON_MASKED" -eq 1 ] && command -v systemctl >/dev/null 2>&1; then
        run systemctl --user unmask saveme.service >/dev/null 2>&1 || true
        DAEMON_MASKED=0
    fi
}

cleanup() {
    if [ "$DAEMON_MASKED" -eq 1 ]; then
        if [ "$DRY_RUN" -eq 0 ]; then
            systemctl --user unmask saveme.service >/dev/null 2>&1 || true
        fi
        DAEMON_MASKED=0
    fi
    if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
        rm -rf "$TMP_DIR"
    fi
}

on_exit() {
    status=$?
    if [ "$EXITING" -eq 1 ]; then
        exit "$status"
    fi
    EXITING=1
    printf 'exit status: %s\n' "$status" >> "$LOG_FILE" 2>/dev/null || true
    cleanup
    if [ "$REMOVE_LOG_ON_EXIT" -eq 1 ]; then
        rm -f "$LOG_FILE" 2>/dev/null || true
    fi
    exit "$status"
}

trap on_exit EXIT INT TERM

# Installation log. Keep it outside the state directory so --purge does not
# destroy the diagnostic log before it can be shared.
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}"
if [ -n "$LOG_OVERRIDE" ]; then
    LOG_FILE="$LOG_OVERRIDE"
else
    LOG_FILE="$LOG_DIR/saveme-install.log"
fi
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
if ! : >> "$LOG_FILE" 2>/dev/null; then
    LOG_FILE="${TMPDIR:-/tmp}/saveme-install.log"
    : >> "$LOG_FILE" 2>/dev/null || true
fi
{
    printf '\n===== SaveMe %s %s =====\n' "$(date -Iseconds 2>/dev/null || date)" "$ACTION"
    printf 'command: %s %s\n' "$0" "$ORIGINAL_ARGS"
    printf 'user: %s host: %s\n' "$(id -un)" "$(hostname 2>/dev/null || echo unknown)"
    printf 'uname: %s\n' "$(uname -a)"
} >> "$LOG_FILE" 2>/dev/null || true

say "Installation log: $LOG_FILE"

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"

if [ "$(id -u)" -eq 0 ]; then
    say "Run this script as your desktop user, not with sudo."
    say "It calls sudo internally for apt."
    exit 1
fi

if [ "$DRY_RUN" -eq 0 ] && ! command -v sudo >/dev/null 2>&1; then
    say "sudo is required to install or remove the system package."
    exit 1
fi

case "$(uname -m)" in
    x86_64|amd64) ARCH="amd64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    *)
        say "Unsupported architecture: $(uname -m)"
        exit 1
        ;;
esac

SCRIPT_DIR=""
case "$0" in
    */*)
        if [ -f "$0" ]; then
            SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
        fi
        ;;
esac
LOCAL_DIST=""
if [ -n "$SCRIPT_DIR" ] && [ -d "$SCRIPT_DIR/../dist" ]; then
    LOCAL_DIST="$(cd "$SCRIPT_DIR/../dist" && pwd)"
fi

TMP_DIR=""

package_installed() {
    command -v dpkg-query >/dev/null 2>&1 || return 1
    dpkg-query -W -f='${Status}' saveme 2>/dev/null |
        grep -q 'install ok installed'
}

package_version() {
    if ! package_installed; then
        return 0
    fi
    dpkg-query -W -f='${Version}' saveme 2>/dev/null || true
}

target_version() {
    if [ ! -f "$DEB" ]; then
        return 0
    fi
    dpkg-deb -f "$DEB" Version 2>/dev/null || true
}

if [ -n "$VERSION" ]; then
    BASE_URL="https://github.com/$REPO/releases/download/v$VERSION"
elif [ "$FORCE_REMOTE" -eq 1 ]; then
    BASE_URL="https://github.com/$REPO/releases/latest/download"
else
    BASE_URL="https://github.com/$REPO/releases/latest/download"
fi

pick_local_deb() {
    if [ -n "$DEB_OVERRIDE" ]; then
        DEB="$DEB_OVERRIDE"
        return 0
    fi
    if [ "$FORCE_REMOTE" -eq 0 ] && [ -z "$VERSION" ] && [ -n "$LOCAL_DIST" ]; then
        if [ -f "$LOCAL_DIST/saveme_${ARCH}.deb" ]; then
            DEB="$LOCAL_DIST/saveme_${ARCH}.deb"
            return 0
        fi
        candidate="$(ls -t "$LOCAL_DIST"/saveme_*_"${ARCH}".deb 2>/dev/null | head -n 1 || true)"
        if [ -n "$candidate" ]; then
            DEB="$candidate"
            return 0
        fi
    fi
    return 1
}

pick_local_extension() {
    if [ -n "$EXT_OVERRIDE" ]; then
        EXT="$EXT_OVERRIDE"
        return 0
    fi
    if [ "$FORCE_REMOTE" -eq 0 ] && [ -z "$VERSION" ] && [ -n "$LOCAL_DIST" ]; then
        if [ -f "$LOCAL_DIST/$UUID.shell-extension.zip" ]; then
            EXT="$LOCAL_DIST/$UUID.shell-extension.zip"
            return 0
        fi
    fi
    return 1
}

verify_checksums() {
    sums_file="$1"
    shift
    [ -f "$sums_file" ] || return 0
    if ! command -v sha256sum >/dev/null 2>&1; then
        say "sha256sum not found; skipping checksum verification."
        return 0
    fi
    sums_dir="$(dirname "$sums_file")"
    for file in "$@"; do
        name="$(basename "$file")"
        if grep -Fq " $name" "$sums_file"; then
            if ! (cd "$sums_dir" && grep -F " $name" "$sums_file" | sha256sum -c - >/dev/null); then
                say "Checksum verification failed for $name."
                exit 1
            fi
            say "Checksum OK: $name"
        else
            say "No checksum found for $name; continuing."
        fi
    done
}

download_artifacts() {
    TMP_DIR="$(mktemp -d)"
    DEB="$TMP_DIR/saveme_${ARCH}.deb"
    EXT="$TMP_DIR/$UUID.shell-extension.zip"
    if [ "$DRY_RUN" -eq 1 ]; then
        say "+ curl -fL --retry 3 -o $DEB $BASE_URL/saveme_${ARCH}.deb"
        if [ "$WITH_EXTENSION" -eq 1 ]; then
            say "+ curl -fL --retry 3 -o $EXT $BASE_URL/$UUID.shell-extension.zip"
        fi
        say "+ curl -fsSL -o $TMP_DIR/SHA256SUMS $BASE_URL/SHA256SUMS"
        return 0
    fi
    command -v curl >/dev/null 2>&1 || {
        say "curl is required."
        exit 1
    }
    say "Downloading $BASE_URL/saveme_${ARCH}.deb"
    curl -fL --retry 3 -o "$DEB" "$BASE_URL/saveme_${ARCH}.deb"
    if [ "$WITH_EXTENSION" -eq 1 ]; then
        say "Downloading $BASE_URL/$UUID.shell-extension.zip"
        curl -fL --retry 3 -o "$EXT" "$BASE_URL/$UUID.shell-extension.zip"
    fi
    if curl -fsSL -o "$TMP_DIR/SHA256SUMS" "$BASE_URL/SHA256SUMS" 2>/dev/null; then
        if [ "$WITH_EXTENSION" -eq 1 ]; then
            verify_checksums "$TMP_DIR/SHA256SUMS" "$DEB" "$EXT"
        else
            verify_checksums "$TMP_DIR/SHA256SUMS" "$DEB"
        fi
    else
        say "SHA256SUMS not found; skipping checksum verification."
    fi
}

stop_daemon() {
    if command -v systemctl >/dev/null 2>&1; then
        if [ "$DRY_RUN" -eq 1 ]; then
            say "+ systemctl --user stop saveme.service"
        else
            systemctl --user stop saveme.service >/dev/null 2>&1 || true
        fi
    fi
    if command -v pkill >/dev/null 2>&1; then
        if [ "$DRY_RUN" -eq 1 ]; then
            say "+ pkill -TERM -f '/usr/lib/saveme/bin/saveme-daemon.js'"
            say "+ pkill -KILL -f '/usr/lib/saveme/bin/saveme-daemon.js'"
        else
            pkill -TERM -f '/usr/lib/saveme/bin/saveme-daemon.js' >/dev/null 2>&1 || true
            sleep 1
            pkill -KILL -f '/usr/lib/saveme/bin/saveme-daemon.js' >/dev/null 2>&1 || true
        fi
    fi
}

stop_app() {
    if command -v pkill >/dev/null 2>&1; then
        if [ "$DRY_RUN" -eq 1 ]; then
            say "+ pkill -TERM -f '/usr/lib/saveme/app/main.js'"
        else
            pkill -TERM -f '/usr/lib/saveme/app/main.js' >/dev/null 2>&1 || true
        fi
    fi
}

start_daemon() {
    if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
        run systemctl --user daemon-reload || true
        if ! run systemctl --user enable --now saveme.service; then
            say "systemd service failed to start; collecting diagnostics"
            if [ "$DRY_RUN" -eq 0 ]; then
                {
                    systemctl --user status saveme.service --no-pager || true
                    journalctl --user -u saveme.service -n 100 --no-pager || true
                } 2>&1 | tee -a "$LOG_FILE"
            fi
        fi
        if [ "$DRY_RUN" -eq 0 ]; then
            sleep 1
        fi
    fi
    if command -v pgrep >/dev/null 2>&1 &&
        pgrep -f '/usr/lib/saveme/bin/saveme-daemon.js' >/dev/null 2>&1; then
        say "Daemon is running."
        return 0
    fi
    if [ "$DRY_RUN" -eq 1 ]; then
        say "+ nohup saveme-daemon >/dev/null 2>&1 &"
    else
        nohup saveme-daemon >/dev/null 2>&1 &
    fi
}

install_extension() {
    [ "$WITH_EXTENSION" -eq 1 ] || return 0
    if [ ! -f "$EXT" ]; then
        say "Extension package not found: ${EXT:-'(not downloaded)'}; skipping."
        return 0
    fi
    if ! command -v gnome-extensions >/dev/null 2>&1; then
        say "gnome-extensions not found; install the extension manually:"
        say "  /usr/share/saveme/extension.zip"
        return 0
    fi
    run gnome-extensions install --force "$EXT" || true
    run gnome-extensions enable "$UUID" || true
    say "If the extension does not appear, log out and log back in."
}

do_install() {
    current="$(package_version)"
    if [ -n "$current" ]; then
        say "SaveMe $current is installed; updating."
    else
        say "SaveMe is not installed; installing."
    fi

    if ! pick_local_deb; then
        download_artifacts
    fi
    if [ "$DRY_RUN" -eq 0 ] && [ ! -f "$DEB" ]; then
        say "Package not found: $DEB"
        exit 1
    fi
    if [ -n "$DEB_OVERRIDE" ] && [ "$DRY_RUN" -eq 0 ] && [ ! -f "$DEB_OVERRIDE" ]; then
        say "Package not found: $DEB_OVERRIDE"
        exit 1
    fi

    if [ "$WITH_EXTENSION" -eq 1 ]; then
        if ! pick_local_extension; then
            if [ -z "${TMP_DIR:-}" ]; then
                TMP_DIR="$(mktemp -d)"
            fi
            EXT="$TMP_DIR/$UUID.shell-extension.zip"
            if [ "$DRY_RUN" -eq 1 ]; then
                say "+ curl -fL --retry 3 -o $EXT $BASE_URL/$UUID.shell-extension.zip"
            else
                command -v curl >/dev/null 2>&1 || {
                    say "curl is required to download the extension."
                    exit 1
                }
                say "Downloading $BASE_URL/$UUID.shell-extension.zip"
                curl -fL --retry 3 -o "$EXT" "$BASE_URL/$UUID.shell-extension.zip"
                if curl -fsSL -o "$TMP_DIR/SHA256SUMS" "$BASE_URL/SHA256SUMS" 2>/dev/null; then
                    verify_checksums "$TMP_DIR/SHA256SUMS" "$EXT"
                else
                    say "SHA256SUMS not found; skipping extension checksum."
                fi
            fi
        fi
        if [ -n "$EXT_OVERRIDE" ] && [ "$DRY_RUN" -eq 0 ] && [ ! -f "$EXT_OVERRIDE" ]; then
            say "Extension not found: $EXT_OVERRIDE"
            exit 1
        fi
    fi

    target="$(target_version)"

    say "SaveMe install/update"
    say "  package:   $DEB"
    if [ -n "$current" ]; then
        say "  installed: $current"
    else
        say "  installed: (none)"
    fi
    if [ -n "$target" ]; then
        say "  target:    $target"
    fi
    if [ "$WITH_EXTENSION" -eq 1 ]; then
        say "  extension: $EXT"
    else
        say "  extension: skipped (--no-extension)"
    fi
    say ""
    if [ "$DRY_RUN" -eq 0 ] && ! sudo -v; then
        say "sudo authentication failed; the package was not installed."
        exit 1
    fi

    stop_daemon
    stop_app
    mask_daemon
    case "$DEB" in
        /*) DEB_INSTALL="$DEB" ;;
        *) DEB_INSTALL="$(pwd)/$DEB" ;;
    esac
    if ! run_sudo apt-get install -y --reinstall "$DEB_INSTALL"; then
        say "apt-get could not install $DEB_INSTALL."
        say "Try manually: sudo apt-get install -y --reinstall $DEB_INSTALL"
        exit 1
    fi
    if ! package_installed; then
        say "apt-get completed but the saveme package is not installed."
        say "Check the apt output above and the package dependencies."
        exit 1
    fi
    unmask_daemon
    install_extension
    if [ "$START_DAEMON" -eq 1 ]; then
        start_daemon
    fi

    if [ "$DRY_RUN" -eq 0 ]; then
        say ""
        say "Installation check:"
        saveme doctor || true
        if [ "$WITH_EXTENSION" -eq 1 ] && command -v gnome-extensions >/dev/null 2>&1; then
            gnome-extensions info "$UUID" 2>/dev/null || true
        fi
        say ""
        say "Open the app with: saveme-settings"
        say "Installation log: $LOG_FILE"
    fi
}

remove_path() {
    path="$1"
    if [ ! -e "$path" ] && [ ! -L "$path" ]; then
        return 0
    fi
    if [ "$DRY_RUN" -eq 1 ]; then
        say "+ rm -rf $path"
    else
        rm -rf "$path"
    fi
}

do_uninstall() {
    if [ "$YES" -ne 1 ] && [ "$DRY_RUN" -ne 1 ]; then
        if [ -r /dev/tty ]; then
            printf 'Remove SaveMe? [y/N] ' > /dev/tty
            read -r answer < /dev/tty || answer=""
            case "$answer" in
                y|Y|yes|YES) ;;
                *) say "Aborted."; exit 0 ;;
            esac
        else
            say "Use --yes to confirm uninstall."
            exit 1
        fi
    fi

    say "Uninstalling SaveMe..."
    if [ "$DRY_RUN" -eq 0 ] && ! sudo -v; then
        say "sudo authentication failed; nothing was removed."
        exit 1
    fi
    stop_daemon
    stop_app
    mask_daemon
    if command -v systemctl >/dev/null 2>&1; then
        if [ "$DRY_RUN" -eq 1 ]; then
            say "+ systemctl --user disable --now saveme.service"
        else
            systemctl --user disable --now saveme.service >/dev/null 2>&1 || true
        fi
    fi
    if command -v gnome-extensions >/dev/null 2>&1; then
        if [ "$DRY_RUN" -eq 1 ]; then
            say "+ gnome-extensions uninstall $UUID"
        else
            gnome-extensions uninstall "$UUID" >/dev/null 2>&1 || true
        fi
    fi
    ext_dir="$HOME/.local/share/gnome-shell/extensions/$UUID"
    remove_path "$ext_dir"

    if [ "$PURGE" -eq 1 ]; then
        remove_path "$CONFIG_HOME/saveme"
        remove_path "$STATE_HOME/saveme"
        remove_path "$CACHE_HOME/saveme"
        if [ -n "${XDG_RUNTIME_DIR:-}" ]; then
            remove_path "$XDG_RUNTIME_DIR/saveme"
        fi
        if [ -z "$LOG_OVERRIDE" ]; then
            REMOVE_LOG_ON_EXIT=1
        fi
    else
        # Keep jobs/state and configuration, but do not leave logs, caches,
        # filters or temporary files behind.
        remove_path "$STATE_HOME/saveme/logs"
        remove_path "$STATE_HOME/saveme/tmp"
        remove_path "$STATE_HOME/saveme/filters"
        remove_path "$CACHE_HOME/saveme"
        if [ -n "${XDG_RUNTIME_DIR:-}" ]; then
            remove_path "$XDG_RUNTIME_DIR/saveme"
        fi
    fi

    if [ "$PURGE" -eq 1 ]; then
        run_sudo apt-get purge -y saveme || run_sudo apt-get remove -y saveme || true
    else
        run_sudo apt-get remove -y saveme || true
    fi
    unmask_daemon

    say ""
    if [ "$PURGE" -eq 1 ]; then
        say "SaveMe removed, including user configuration, tokens, logs and history."
    else
        say "SaveMe removed. Logs, caches, filters and temporary files were cleaned."
        say "User configuration and job state were kept:"
        say "  $CONFIG_HOME/saveme"
        say "  $STATE_HOME/saveme"
        say "Use --purge to remove them."
    fi
    say "Uninstall log: $LOG_FILE"
}

if [ "$ACTION" = "uninstall" ]; then
    do_uninstall
else
    do_install
fi
