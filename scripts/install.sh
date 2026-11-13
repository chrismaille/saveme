#!/bin/sh
# SaveMe installer / uninstaller.
#
# Local checkout:
#   ./scripts/install.sh
#   ./scripts/install.sh --uninstall --purge --yes
#
# Published:
#   curl -fsSL https://raw.githubusercontent.com/chrismaille/save_me/master/scripts/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/chrismaille/save_me/master/scripts/install.sh | sh -s -- --uninstall --purge --yes
#
# Run as your desktop user, not with sudo. The script calls sudo only for apt.

set -eu

REPO="${SAVEME_REPO:-chrismaille/save_me}"
UUID="saveme@chrismaille.github.io"
ACTION="install"
PURGE=0
YES=0
DRY_RUN=0
WITH_EXTENSION=1
START_DAEMON=1
FORCE_REMOTE=0
VERSION=""
DEB_OVERRIDE=""
EXT_OVERRIDE=""

usage() {
    cat <<EOF
SaveMe installer

Usage:
  install.sh [options]

Options:
  --uninstall          Remove SaveMe (daemon, extension and package)
  --purge              With --uninstall: also remove config, tokens, logs and history
  --yes                Do not prompt for confirmation
  --dry-run            Print the plan without changing anything
  --no-extension       Do not install the GNOME Shell extension
  --no-start           Do not start the daemon after installation
  --version VERSION    Install a specific release (e.g. 1.0.0)
  --deb PATH           Use a local .deb
  --extension PATH     Use a local extension zip
  --repo OWNER/REPO    GitHub repository (default: $REPO)
  --remote             Download artifacts even if a local dist/ exists
  -h, --help           Show this help

Examples:
  ./scripts/install.sh
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
        --no-extension) WITH_EXTENSION=0; shift ;;
        --no-start) START_DAEMON=0; shift ;;
        --remote) FORCE_REMOTE=1; shift ;;
        --version) VERSION="${2:-}"; shift 2 ;;
        --deb) DEB_OVERRIDE="${2:-}"; shift 2 ;;
        --extension) EXT_OVERRIDE="${2:-}"; shift 2 ;;
        --repo) REPO="${2:-}"; shift 2 ;;
        --help|-h) usage; exit 0 ;;
        *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
    esac
done

say() {
    printf '%s\n' "$*"
}

run() {
    if [ "$DRY_RUN" -eq 1 ]; then
        printf '+ %s\n' "$*"
    else
        "$@"
    fi
}

run_sudo() {
    if [ "$DRY_RUN" -eq 1 ]; then
        printf '+ sudo %s\n' "$*"
    else
        sudo "$@"
    fi
}

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
cleanup() {
    if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
        rm -rf "$TMP_DIR"
    fi
}
trap cleanup EXIT INT TERM

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
    if [ "$FORCE_REMOTE" -eq 0 ] && [ -n "$LOCAL_DIST" ]; then
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
    if [ "$FORCE_REMOTE" -eq 0 ] && [ -n "$LOCAL_DIST" ]; then
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

start_daemon() {
    if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
        run systemctl --user daemon-reload || true
        run systemctl --user enable --now saveme.service || true
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
    if ! command -v gnome-extensions >/dev/null 2>&1; then
        say "gnome-extensions not found; install the extension manually:"
        say "  $EXT"
        return 0
    fi
    run gnome-extensions install --force "$EXT" || true
    run gnome-extensions enable "$UUID" || true
    say "If the extension does not appear, log out and log back in."
}

do_install() {
    if pick_local_deb; then
        : # local package selected
    else
        download_artifacts
    fi
    if pick_local_extension; then
        : # local extension selected
    elif [ -z "${EXT:-}" ]; then
        if [ -z "${TMP_DIR:-}" ]; then
            TMP_DIR="$(mktemp -d)"
            EXT="$TMP_DIR/$UUID.shell-extension.zip"
            if [ "$DRY_RUN" -eq 1 ]; then
                say "+ curl -fL --retry 3 -o $EXT $BASE_URL/$UUID.shell-extension.zip"
            else
                curl -fL --retry 3 -o "$EXT" "$BASE_URL/$UUID.shell-extension.zip"
            fi
        fi
    fi

    say "SaveMe installer"
    say "  package:   $DEB"
    if [ "$WITH_EXTENSION" -eq 1 ]; then
        say "  extension: $EXT"
    fi
    say ""

    stop_daemon
    run_sudo apt-get install -y --reinstall "$DEB"
    install_extension
    if [ "$START_DAEMON" -eq 1 ]; then
        start_daemon
    fi

    if [ "$DRY_RUN" -eq 0 ]; then
        say ""
        say "Installation check:"
        saveme doctor || true
        if command -v gnome-extensions >/dev/null 2>&1; then
            gnome-extensions info "$UUID" 2>/dev/null || true
        fi
        say ""
        say "Open the app with: saveme-settings"
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
    stop_daemon
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
    if [ -d "$ext_dir" ]; then
        if [ "$DRY_RUN" -eq 1 ]; then
            say "+ rm -rf $ext_dir"
        else
            rm -rf "$ext_dir"
        fi
    fi

    if [ "$PURGE" -eq 1 ]; then
        for path in "$HOME/.config/saveme" "$HOME/.local/state/saveme" \
            "$HOME/.cache/saveme"; do
            if [ -e "$path" ]; then
                if [ "$DRY_RUN" -eq 1 ]; then
                    say "+ rm -rf $path"
                else
                    rm -rf "$path"
                fi
            fi
        done
        if [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -e "$XDG_RUNTIME_DIR/saveme" ]; then
            if [ "$DRY_RUN" -eq 1 ]; then
                say "+ rm -rf $XDG_RUNTIME_DIR/saveme"
            else
                rm -rf "$XDG_RUNTIME_DIR/saveme"
            fi
        fi
    fi

    if [ "$PURGE" -eq 1 ]; then
        run_sudo apt-get purge -y saveme || run_sudo apt-get remove -y saveme || true
    else
        run_sudo apt-get remove -y saveme || true
    fi

    say ""
    if [ "$PURGE" -eq 1 ]; then
        say "SaveMe removed, including user configuration, tokens, logs and history."
    else
        say "SaveMe removed. User data was kept:"
        say "  $HOME/.config/saveme"
        say "  $HOME/.local/state/saveme"
        say "Use --purge to remove it."
    fi
}

if [ "$ACTION" = "uninstall" ]; then
    do_uninstall
else
    do_install
fi
