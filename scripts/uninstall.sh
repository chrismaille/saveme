#!/bin/sh
# SaveMe uninstaller. Thin wrapper around install.sh --uninstall.
#
# Local checkout:
#   ./scripts/uninstall.sh --purge --yes
#
# Published:
#   curl -fsSL https://raw.githubusercontent.com/chrismaille/save_me/main/scripts/uninstall.sh | sh -s -- --purge --yes

set -eu

SCRIPT_DIR=""
case "$0" in
    */*)
        if [ -f "$0" ]; then
            SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
        fi
        ;;
esac

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/install.sh" ]; then
    exec sh "$SCRIPT_DIR/install.sh" --uninstall "$@"
fi

REPO="${SAVEME_REPO:-chrismaille/save_me}"
URL="https://raw.githubusercontent.com/$REPO/main/scripts/install.sh"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT INT TERM

echo "Downloading $URL"
curl -fsSL "$URL" -o "$TMP"
sh "$TMP" --uninstall "$@"
