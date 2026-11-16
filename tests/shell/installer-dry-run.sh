#!/bin/sh
# Dry-run smoke tests for scripts/install.sh. No sudo or apt is executed.

set -eu

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/saveme-installer-test-XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

export HOME="$TMP_DIR/home"
export XDG_CONFIG_HOME="$TMP_DIR/config"
export XDG_STATE_HOME="$TMP_DIR/state"
export XDG_CACHE_HOME="$TMP_DIR/cache"
export XDG_RUNTIME_DIR="$TMP_DIR/run"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_STATE_HOME" \
    "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

FAKE_BIN="$TMP_DIR/bin"
mkdir -p "$FAKE_BIN"
cat >"$FAKE_BIN/dpkg-query" <<'EOF'
#!/bin/sh
if [ "${SAVEME_FAKE_NOT_INSTALLED:-0}" = 1 ]; then
    case "$*" in
        *Status*) printf '%s\n' 'deinstall ok config-files' ;;
        *Version*) ;;
    esac
    exit 0
fi
case "$*" in
    *Status*) printf '%s\n' 'install ok installed' ;;
    *Version*) printf '%s\n' '1.0.0' ;;
esac
EOF
chmod +x "$FAKE_BIN/dpkg-query"
PATH="$FAKE_BIN:$PATH"
export PATH

FAKE_DEB="$TMP_DIR/saveme_fake.deb"
: >"$FAKE_DEB"

run_plan() {
    sh "$ROOT_DIR/scripts/install.sh" --dry-run "$@"
}

OUTPUT="$(run_plan --no-extension --deb "$FAKE_DEB")"
printf '%s\n' "$OUTPUT" | grep -q 'SaveMe install/update'
printf '%s\n' "$OUTPUT" | grep -q 'is installed; updating'
printf '%s\n' "$OUTPUT" | grep -q 'extension: skipped'
if printf '%s\n' "$OUTPUT" | grep -q 'shell-extension.zip'; then
    echo "app-only install must not download the extension" >&2
    exit 1
fi
printf '%s\n' "$OUTPUT" | grep -q 'apt-get install -y --reinstall'

OUTPUT="$(run_plan --deb "$FAKE_DEB")"
printf '%s\n' "$OUTPUT" | grep -q 'shell-extension.zip'

OUTPUT="$(SAVEME_FAKE_NOT_INSTALLED=1 run_plan --deb "$FAKE_DEB")"
printf '%s\n' "$OUTPUT" | grep -q 'is not installed; installing'

for path in "$XDG_STATE_HOME/saveme/logs" "$XDG_STATE_HOME/saveme/tmp" \
    "$XDG_STATE_HOME/saveme/filters" "$XDG_CACHE_HOME/saveme" \
    "$XDG_RUNTIME_DIR/saveme"; do
    mkdir -p "$path"
done
OUTPUT="$(sh "$ROOT_DIR/scripts/install.sh" --uninstall --yes --dry-run \
    --no-extension)"
printf '%s\n' "$OUTPUT" | grep -q 'rm -rf'
printf '%s\n' "$OUTPUT" | grep -q 'User configuration and job state were kept'
if printf '%s\n' "$OUTPUT" | grep -q 'rm -rf .*config/saveme'; then
    echo "normal uninstall must preserve configuration" >&2
    exit 1
fi

OUTPUT="$(sh "$ROOT_DIR/scripts/install.sh" --uninstall --purge --yes --dry-run \
    --no-extension)"
printf '%s\n' "$OUTPUT" | grep -q 'including user configuration'

if sh "$ROOT_DIR/scripts/install.sh" --purge --dry-run \
    --no-extension >/dev/null 2>&1; then
    echo "--purge must require --uninstall" >&2
    exit 1
fi

echo "Installer dry-run: OK"
