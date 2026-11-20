#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${PPA_OUT_DIR:-$ROOT_DIR/build/ppa}"
VERSION="$(cd "$ROOT_DIR" && dpkg-parsechangelog -SVersion)"
UPSTREAM="${VERSION%%-*}"
STAGE="$OUT_DIR/saveme-${UPSTREAM}"

rm -rf "$STAGE" "$OUT_DIR/saveme_${UPSTREAM}.orig.tar.gz"

mkdir -p "$STAGE"
rsync -a \
    --exclude .git \
    --exclude .github \
    --exclude .idea \
    --exclude .venv \
    --exclude build \
    --exclude dist \
    --exclude node_modules \
    --exclude tools \
    --exclude .env \
    --exclude save_me.iml \
    "$ROOT_DIR/" "$STAGE/"

(
    cd "$OUT_DIR"
    tar --exclude="${STAGE##*/}/debian" \
        --exclude="${STAGE##*/}/debian/*" \
        -czf "saveme_${UPSTREAM}.orig.tar.gz" "${STAGE##*/}"
)

(
    cd "$STAGE"
    dpkg-buildpackage -S -sa "$@"
)

echo "PPA source package ready in $OUT_DIR"
echo "Upload with:"
echo "  dput ppa:chrismaille/saveme $OUT_DIR/saveme_${VERSION}_source.changes"
