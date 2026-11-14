#!/bin/sh
# Headless app smoke/E2E: start a private daemon and GNOME Shell, launch the
# GTK app with --smoke-test, and verify that it receives a real snapshot,
# renders every view and exits cleanly.

set -eu

if [ "${SAVEME_E2E_APP_SESSION:-0}" -ne 1 ]; then
    export SAVEME_E2E_APP_SESSION=1
    exec dbus-run-session -- "$0" "$@"
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/saveme-e2e-app-XXXXXX")"

cleanup() {
    [ -n "${APP_PID:-}" ] && kill "$APP_PID" 2>/dev/null || true
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
export GSK_RENDERER=cairo
export SAVEME_RCLONE="${SAVEME_RCLONE:-$ROOT_DIR/tools/rclone}"

mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_STATE_HOME" \
    "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR" "$BASE/src" "$BASE/dst"
chmod 700 "$XDG_RUNTIME_DIR"
printf 'hello\n' > "$BASE/src/a.txt"

"$ROOT_DIR/tools/rclone" version >/dev/null
gjs -m "$ROOT_DIR/bin/saveme.js" job add \
    --name "App Smoke" --type sync \
    --source "$BASE/src" --dest "$BASE/dst" \
    >"$BASE/cli-add.log" 2>&1

gjs -m "$ROOT_DIR/bin/saveme-daemon.js" >"$BASE/daemon.log" 2>&1 &
DAEMON_PID=$!

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

i=0
while [ ! -S "$XDG_RUNTIME_DIR/wayland-0" ]; do
    i=$((i + 1))
    if [ "$i" -ge 100 ]; then
        echo "Headless Wayland compositor did not start" >&2
        tail -n 60 "$BASE/shell.log" >&2
        exit 1
    fi
    sleep 0.2
done
sleep 2

WAYLAND_DISPLAY=wayland-0 GDK_BACKEND=wayland \
    gjs -m "$ROOT_DIR/app/main.js" --smoke-test --soak-test \
    --soak-iterations "${SAVEME_APP_SOAK_ITERATIONS:-120}" >"$BASE/app.log" 2>&1 &
APP_PID=$!

i=0
while kill -0 "$APP_PID" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -ge 300 ]; then
        echo "App smoke test timed out" >&2
        tail -n 60 "$BASE/app.log" >&2
        exit 1
    fi
    sleep 0.1
done

set +e
wait "$APP_PID"
APP_EXIT=$?
set -e
APP_PID=

if [ "$APP_EXIT" -ne 0 ]; then
    echo "App smoke test exited with $APP_EXIT" >&2
    cat "$BASE/app.log" >&2
    exit 1
fi

if ! grep -q 'SaveMe app smoke: OK' "$BASE/app.log"; then
    echo "App smoke test did not report success" >&2
    cat "$BASE/app.log" >&2
    exit 1
fi

if ! grep -q 'jobs=1' "$BASE/app.log"; then
    echo "App smoke test received an unexpected snapshot" >&2
    cat "$BASE/app.log" >&2
    exit 1
fi

if ! grep -q 'SaveMe app soak: OK' "$BASE/app.log"; then
    echo "App memory soak did not report success" >&2
    cat "$BASE/app.log" >&2
    exit 1
fi

grep 'SaveMe app ' "$BASE/app.log" || true

APP_LOG="$XDG_STATE_HOME/saveme/logs/app.log"
if [ ! -f "$APP_LOG" ] || ! grep -q 'Performance sample' "$APP_LOG"; then
    echo "App log does not contain performance samples" >&2
    tail -n 40 "$APP_LOG" 2>/dev/null >&2 || true
    exit 1
fi

LOGS_INFO="$(gdbus call --session \
    --dest io.github.chrismaille.SaveMe.Daemon \
    --object-path /io/github/chrismaille/SaveMe/Daemon \
    --method io.github.chrismaille.SaveMe.Daemon.GetLogsInfo)"
if ! printf '%s' "$LOGS_INFO" | grep -q 'totalBytes'; then
    echo "GetLogsInfo did not return a log inventory" >&2
    printf '%s\n' "$LOGS_INFO" >&2
    exit 1
fi

SANITIZED="$(gdbus call --session \
    --dest io.github.chrismaille.SaveMe.Daemon \
    --object-path /io/github/chrismaille/SaveMe/Daemon \
    --method io.github.chrismaille.SaveMe.Daemon.SanitizeLogs)"
if ! printf '%s' "$SANITIZED" | grep -q 'files'; then
    echo "SanitizeLogs did not return a result" >&2
    printf '%s\n' "$SANITIZED" >&2
    exit 1
fi

PRUNED="$(gdbus call --session \
    --dest io.github.chrismaille.SaveMe.Daemon \
    --object-path /io/github/chrismaille/SaveMe/Daemon \
    --method io.github.chrismaille.SaveMe.Daemon.PruneLogs)"
if ! printf '%s' "$PRUNED" | grep -q 'deleted'; then
    echo "PruneLogs did not return a result" >&2
    printf '%s\n' "$PRUNED" >&2
    exit 1
fi

CLEARED="$(gdbus call --session \
    --dest io.github.chrismaille.SaveMe.Daemon \
    --object-path /io/github/chrismaille/SaveMe/Daemon \
    --method io.github.chrismaille.SaveMe.Daemon.ClearLogs 'run-logs')"
if ! printf '%s' "$CLEARED" | grep -q 'run-logs'; then
    echo "ClearLogs did not return a result" >&2
    printf '%s\n' "$CLEARED" >&2
    exit 1
fi

gdbus call --session \
    --dest io.github.chrismaille.SaveMe.Daemon \
    --object-path /io/github/chrismaille/SaveMe/Daemon \
    --method io.github.chrismaille.SaveMe.Daemon.UpdateSettings \
    '{"logRetentionDays":7,"maxLogTotalBytes":1048576}' >/dev/null
SETTINGS="$(gdbus call --session \
    --dest io.github.chrismaille.SaveMe.Daemon \
    --object-path /io/github/chrismaille/SaveMe/Daemon \
    --method io.github.chrismaille.SaveMe.Daemon.GetSnapshot)"
if ! printf '%s' "$SETTINGS" | grep -q '"logRetentionDays":7'; then
    echo "UpdateSettings did not persist the log policy" >&2
    exit 1
fi
if ! printf '%s' "$SETTINGS" | grep -q '"process"'; then
    echo "Daemon snapshot does not expose process metrics" >&2
    exit 1
fi
if ! printf '%s' "$SETTINGS" | grep -q '"diskSafetyPercent"'; then
    echo "Daemon snapshot does not expose disk safety settings" >&2
    exit 1
fi

if grep -qiE 'Gjs-CRITICAL|JS ERROR|Gtk-CRITICAL|Adw-CRITICAL' "$BASE/app.log"; then
    echo "The app reported GTK/GJS errors" >&2
    grep -iE 'Gjs-CRITICAL|JS ERROR|Gtk-CRITICAL|Adw-CRITICAL' "$BASE/app.log" >&2
    exit 1
fi

if ! grep -q 'hello' "$BASE/dst/a.txt" 2>/dev/null; then
    echo "Daemon did not sync the app smoke file" >&2
    tail -n 60 "$BASE/daemon.log" >&2
    exit 1
fi

echo "App E2E: OK"
