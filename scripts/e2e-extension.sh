#!/bin/sh
# Headless GNOME Shell E2E: install the extension, enable it, start the daemon
# and verify that the extension reaches ACTIVE without Shell JS errors.

set -eu

if [ "${SAVEME_E2E_EXT_SESSION:-0}" -ne 1 ]; then
    export SAVEME_E2E_EXT_SESSION=1
    exec dbus-run-session -- "$0" "$@"
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/saveme-e2e-ext-XXXXXX")"
EXT_ZIP="$ROOT_DIR/dist/saveme@chrismaille.github.io.shell-extension.zip"
UUID="saveme@chrismaille.github.io"

if [ ! -f "$EXT_ZIP" ]; then
    echo "Extension zip not found: $EXT_ZIP. Run: make extension" >&2
    exit 1
fi

cleanup() {
    [ -n "${SHELL_PID:-}" ] && kill "$SHELL_PID" 2>/dev/null || true
    [ -n "${DAEMON_PID:-}" ] && kill "$DAEMON_PID" 2>/dev/null || true
    wait 2>/dev/null || true
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

export BASE="$TMP_DIR"
export XDG_DATA_HOME="$BASE/data"
export XDG_CONFIG_HOME="$BASE/config"
export XDG_STATE_HOME="$BASE/state"
export XDG_CACHE_HOME="$BASE/cache"
export XDG_RUNTIME_DIR="$BASE/run"
export GSETTINGS_BACKEND=memory
export LIBGL_ALWAYS_SOFTWARE=1
export SAVEME_RCLONE="${SAVEME_RCLONE:-$ROOT_DIR/tools/rclone}"

mkdir -p "$XDG_DATA_HOME/gnome-shell/extensions" \
    "$XDG_CONFIG_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR" \
    "$BASE/src" "$BASE/dst"
chmod 700 "$XDG_RUNTIME_DIR"
printf 'hello\n' > "$BASE/src/a.txt"

unzip -q -o "$EXT_ZIP" \
    -d "$XDG_DATA_HOME/gnome-shell/extensions/$UUID"

"$ROOT_DIR/tools/rclone" version >/dev/null
gjs -m "$ROOT_DIR/bin/saveme.js" job add \
    --name "Extension E2E" --type sync \
    --source "$BASE/src" --dest "$BASE/dst" \
    >"$BASE/cli-add.log" 2>&1

gjs -m "$ROOT_DIR/bin/saveme-daemon.js" >"$BASE/daemon.log" 2>&1 &
DAEMON_PID=$!

# Wait for the test daemon to own the bus name and export GetSnapshot before
# starting the Shell. Otherwise the extension can trigger D-Bus activation of
# the installed daemon instead of this test process.
i=0
while ! gdbus call --session \
    --dest io.github.chrismaille.SaveMe.Daemon \
    --object-path /io/github/chrismaille/SaveMe/Daemon \
    --method io.github.chrismaille.SaveMe.Daemon.GetSnapshot \
    >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -ge 100 ]; then
        echo "Test daemon did not become ready" >&2
        tail -n 40 "$BASE/daemon.log" >&2
        exit 1
    fi
    sleep 0.2
done

gnome-shell --headless --wayland --no-x11 \
    --virtual-monitor 1024x768 >"$BASE/shell.log" 2>&1 &
SHELL_PID=$!

sleep 8
gnome-extensions enable "$UUID" >"$BASE/enable.log" 2>&1 || true
sleep 4
gnome-extensions info "$UUID" >"$BASE/info.log" 2>&1 || true

STATUS="$(grep -E 'Estado|State' "$BASE/info.log" | head -n 1 || true)"
echo "$STATUS"

if ! grep -q 'ACTIVE' "$BASE/info.log"; then
    echo "Extension did not become ACTIVE" >&2
    cat "$BASE/info.log" >&2
    tail -n 60 "$BASE/shell.log" >&2
    exit 1
fi

if grep -qiE 'Gjs-CRITICAL|JS ERROR|Extension .*Error' "$BASE/shell.log"; then
    echo "GNOME Shell reported extension errors" >&2
    grep -iE 'Gjs-CRITICAL|JS ERROR|Extension .*Error' "$BASE/shell.log" >&2
    exit 1
fi

if ! grep -q 'hello' "$BASE/dst/a.txt" 2>/dev/null; then
    echo "Daemon did not sync the E2E file" >&2
    tail -n 60 "$BASE/daemon.log" >&2
    exit 1
fi

echo "Extension E2E: OK"
