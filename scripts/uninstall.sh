#!/bin/sh
# SaveMe uninstaller. Thin wrapper around install.sh --uninstall.
#
# Local checkout:
#   ./scripts/uninstall.sh --purge --yes
#
# Published:
#   curl -fsSL https://raw.githubusercontent.com/chrismaille/saveme/main/scripts/uninstall.sh | sh -s -- --purge --yes

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

REPO="${SAVEME_REPO:-chrismaille/saveme}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT INT TERM

for branch in main master; do
    URL="https://raw.githubusercontent.com/$REPO/$branch/scripts/install.sh"
    if curl -fsSL "$URL" -o "$TMP" 2>/dev/null; then
        break
    fi
done

if [ ! -s "$TMP" ]; then
    echo "Cannot download install.sh from $REPO." >&2
    exit 1
fi

sh "$TMP" --uninstall "$@"
