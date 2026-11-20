#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${1:-$ROOT_DIR/build/apt}"
ARCH="${ARCH:-$(dpkg --print-architecture)}"
VERSION="${VERSION:-$(dpkg-deb -f "$ROOT_DIR/dist/saveme_${ARCH}.deb" Version)}"
DEB="$ROOT_DIR/dist/saveme_${VERSION}_${ARCH}.deb"
EXT_ZIP="$ROOT_DIR/dist/saveme@chrismaille.github.io.shell-extension.zip"
PUBLIC_KEY="$ROOT_DIR/data/apt/saveme-archive-keyring.gpg"

if [[ ! -f "$DEB" ]]; then
    echo "Package not found: $DEB" >&2
    exit 1
fi
if [[ ! -f "$PUBLIC_KEY" ]]; then
    echo "Repository public key not found: $PUBLIC_KEY" >&2
    exit 1
fi
if ! command -v gpg >/dev/null 2>&1; then
    echo "gpg not found." >&2
    exit 1
fi

mkdir -p \
    "$OUT_DIR/pool/main/s/saveme" \
    "$OUT_DIR/dists/stable/main/binary-${ARCH}"

cp -f "$DEB" "$OUT_DIR/pool/main/s/saveme/"
cp -f "$ROOT_DIR/dist/SHA256SUMS" "$OUT_DIR/SHA256SUMS"
cp -f "$PUBLIC_KEY" "$OUT_DIR/saveme-archive-keyring.gpg"
if [[ -f "$ROOT_DIR/data/apt/index.html" ]]; then
    cp -f "$ROOT_DIR/data/apt/index.html" "$OUT_DIR/index.html"
fi
touch "$OUT_DIR/.nojekyll"
if [[ -f "$EXT_ZIP" ]]; then
    cp -f "$EXT_ZIP" "$OUT_DIR/"
fi

(
    cd "$OUT_DIR"
    if command -v apt-ftparchive >/dev/null 2>&1; then
        apt-ftparchive packages pool > "dists/stable/main/binary-${ARCH}/Packages"
        gzip -kf "dists/stable/main/binary-${ARCH}/Packages"
        apt-ftparchive \
            -o APT::FTPArchive::Release::Origin=SaveMe \
            -o APT::FTPArchive::Release::Label=SaveMe \
            -o APT::FTPArchive::Release::Suite=stable \
            -o APT::FTPArchive::Release::Codename=stable \
            -o APT::FTPArchive::Release::Architectures="$ARCH" \
            -o APT::FTPArchive::Release::Components=main \
            release dists/stable > dists/stable/Release
    else
        dpkg-scanpackages pool /dev/null > "dists/stable/main/binary-${ARCH}/Packages"
        gzip -kf "dists/stable/main/binary-${ARCH}/Packages"
        {
            printf 'Origin: SaveMe\n'
            printf 'Label: SaveMe\n'
            printf 'Suite: stable\n'
            printf 'Codename: stable\n'
            printf 'Architectures: %s\n' "$ARCH"
            printf 'Components: main\n'
            printf 'Date: %s\n' "$(LC_ALL=C date -Ru)"
            printf 'MD5Sum:\n'
            for file in "main/binary-${ARCH}/Packages" "main/binary-${ARCH}/Packages.gz"; do
                printf ' %s %s %s\n' \
                    "$(md5sum "dists/stable/$file" | cut -d' ' -f1)" \
                    "$(stat -c %s "dists/stable/$file")" "$file"
            done
            printf 'SHA256:\n'
            for file in "main/binary-${ARCH}/Packages" "main/binary-${ARCH}/Packages.gz"; do
                printf ' %s %s %s\n' \
                    "$(sha256sum "dists/stable/$file" | cut -d' ' -f1)" \
                    "$(stat -c %s "dists/stable/$file")" "$file"
            done
        } > dists/stable/Release
    fi
    gpg --batch --yes --clearsign \
        -o dists/stable/InRelease dists/stable/Release
    gpg --batch --yes --armor --detach-sign \
        -o dists/stable/Release.gpg dists/stable/Release
)

echo "APT repository ready: $OUT_DIR"
