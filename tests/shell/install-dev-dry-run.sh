#!/bin/sh
# Isolated installation smoke test for scripts/install-dev.sh.
# Uses temporary HOME/XDG directories and skips systemd/extension integration.

set -eu

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/saveme-dev-installer-test-XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

export HOME="$TMP_DIR/home"
export XDG_CONFIG_HOME="$TMP_DIR/config"
export XDG_STATE_HOME="$TMP_DIR/state"
export XDG_CACHE_HOME="$TMP_DIR/cache"
export XDG_DATA_HOME="$TMP_DIR/data"
export XDG_RUNTIME_DIR="$TMP_DIR/run"
export SAVEME_DEV_SKIP_SYSTEMD=1
export SAVEME_DEV_SKIP_EXTENSION=1
export SAVEME_RCLONE="${SAVEME_RCLONE:-$ROOT_DIR/tools/rclone}"

mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME" \
    "$XDG_DATA_HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

PREFIX="$XDG_DATA_HOME/saveme-dev"
BIN_DIR="$HOME/.local/bin"

OUTPUT="$(sh "$ROOT_DIR/scripts/install-dev.sh" --dry-run --no-start)"
printf '%s\n' "$OUTPUT" | grep -q 'SaveMe Dev install'
printf '%s\n' "$OUTPUT" | grep -q "$PREFIX"
printf '%s\n' "$OUTPUT" | grep -q 'io.github.chrismaille.SaveMe.Dev.Settings'
printf '%s\n' "$OUTPUT" | grep -q 'saveme-dev@chrismaille.github.io'

sh "$ROOT_DIR/scripts/install-dev.sh" --no-start >/dev/null

for path in "$BIN_DIR/saveme-dev" "$BIN_DIR/saveme-dev-daemon" \
    "$BIN_DIR/saveme-dev-settings" "$PREFIX/env.sh" "$PREFIX/extension.zip"; do
    if [ ! -e "$path" ]; then
        echo "missing development install file: $path" >&2
        exit 1
    fi
done

if [ ! -x "$BIN_DIR/saveme-dev" ]; then
    echo "saveme-dev wrapper is not executable" >&2
    exit 1
fi

grep -q "SAVEME_CONFIG_DIR=\"$XDG_CONFIG_HOME/saveme-dev\"" "$PREFIX/env.sh"
grep -q 'SAVEME_DAEMON_BUS_NAME="io.github.chrismaille.SaveMe.Dev.Daemon"' \
    "$PREFIX/env.sh"
unzip -p "$PREFIX/extension.zip" daemon-client.js |
    grep -q "DAEMON_OBJECT_PATH = '/io/github/chrismaille/SaveMe/Dev/Daemon'"
unzip -p "$PREFIX/extension.zip" metadata.json |
    grep -q '"uuid": "saveme-dev@chrismaille.github.io"'
unzip -p "$PREFIX/extension.zip" metadata.json | grep -q '"dev": true'
unzip -l "$PREFIX/extension.zip" | grep -q 'icons/saveme-dev.png'
cmp "$ROOT_DIR/assets/saveme-dev.png" \
    "$XDG_DATA_HOME/icons/hicolor/256x256/apps/io.github.chrismaille.SaveMe.Dev.png"

HELP="$("$BIN_DIR/saveme-dev" --help)"
printf '%s\n' "$HELP" | grep -q 'Open the SaveMe application'

if [ -e "$XDG_CONFIG_HOME/saveme" ] || [ -e "$XDG_STATE_HOME/saveme" ]; then
    echo "development install touched production config/state" >&2
    exit 1
fi

sh "$ROOT_DIR/scripts/install-dev.sh" --uninstall --yes >/dev/null

if [ -e "$PREFIX" ] || [ -e "$BIN_DIR/saveme-dev" ]; then
    echo "development uninstall left files behind" >&2
    exit 1
fi

echo "Development installer: OK"
