#!/bin/sh
# End-to-end tests for the daemon, D-Bus, sync and backup/restore.
# Runs in a private D-Bus session with temporary XDG directories.

set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/saveme-e2e-XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

export XDG_CONFIG_HOME="$TMP_DIR/config"
export XDG_STATE_HOME="$TMP_DIR/state"
export XDG_CACHE_HOME="$TMP_DIR/cache"
export XDG_RUNTIME_DIR="$TMP_DIR/run"
export SAVEME_E2E_ROOT="$TMP_DIR"
export SAVEME_RCLONE="${SAVEME_RCLONE:-$ROOT_DIR/tools/rclone}"

mkdir -p "$XDG_CONFIG_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

exec dbus-run-session -- gjs -m "$ROOT_DIR/tests/e2e/run.js"
