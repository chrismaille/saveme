#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="${VERSION:-1.4.1}"
ARCH="${ARCH:-$(dpkg --print-architecture)}"
MAINTAINER="${MAINTAINER:-chrismaille <chrismaille@users.noreply.github.com>}"
STAGE="$ROOT_DIR/build/deb/saveme_${VERSION}_${ARCH}"
RCLONE="$ROOT_DIR/tools/rclone"
EXT_ZIP="$ROOT_DIR/dist/saveme@chrismaille.github.io.shell-extension.zip"

if [[ ! -x "$RCLONE" ]]; then
    echo "rclone not found at $RCLONE. Run: make setup" >&2
    exit 1
fi
if [[ ! -f "$EXT_ZIP" ]]; then
    echo "extension zip not found at $EXT_ZIP. Run: make extension" >&2
    exit 1
fi

rm -rf "$STAGE"
mkdir -p "$STAGE/DEBIAN" \
    "$STAGE/usr/bin" \
    "$STAGE/usr/lib/saveme/bin" \
    "$STAGE/usr/lib/saveme/src" \
    "$STAGE/usr/lib/saveme/app" \
    "$STAGE/usr/lib/saveme/assets" \
    "$STAGE/usr/lib/systemd/user" \
    "$STAGE/usr/share/dbus-1/services" \
    "$STAGE/usr/share/applications" \
    "$STAGE/usr/share/icons/hicolor/scalable/apps" \
    "$STAGE/usr/share/saveme" \
    "$STAGE/etc/xdg/autostart" \
    "$STAGE/usr/share/doc/saveme"

cp -a "$ROOT_DIR/src/." "$STAGE/usr/lib/saveme/src/"
cp -a "$ROOT_DIR/app/." "$STAGE/usr/lib/saveme/app/"
cp -a "$ROOT_DIR/assets/." "$STAGE/usr/lib/saveme/assets/"
install -Dm755 "$ROOT_DIR/bin/saveme.js" "$STAGE/usr/lib/saveme/bin/saveme.js"
install -Dm755 "$ROOT_DIR/bin/saveme-daemon.js" "$STAGE/usr/lib/saveme/bin/saveme-daemon.js"
install -Dm755 "$RCLONE" "$STAGE/usr/lib/saveme/bin/rclone"

install -Dm644 "$ROOT_DIR/data/saveme.service" \
    "$STAGE/usr/lib/systemd/user/saveme.service"
install -Dm644 "$ROOT_DIR/data/io.github.chrismaille.SaveMe.Daemon.service" \
    "$STAGE/usr/share/dbus-1/services/io.github.chrismaille.SaveMe.Daemon.service"
install -Dm644 "$ROOT_DIR/data/io.github.chrismaille.SaveMe.Settings.desktop" \
    "$STAGE/usr/share/applications/io.github.chrismaille.SaveMe.Settings.desktop"
install -Dm644 "$ROOT_DIR/data/io.github.chrismaille.SaveMe.Daemon.desktop" \
    "$STAGE/usr/share/applications/io.github.chrismaille.SaveMe.Daemon.desktop"
install -Dm644 "$ROOT_DIR/data/saveme-daemon-autostart.desktop" \
    "$STAGE/etc/xdg/autostart/saveme-daemon.desktop"
install -Dm644 "$ROOT_DIR/assets/icon.png" \
    "$STAGE/usr/share/icons/hicolor/256x256/apps/io.github.chrismaille.SaveMe.png"
install -Dm644 "$EXT_ZIP" "$STAGE/usr/share/saveme/extension.zip"
install -Dm644 "$ROOT_DIR/LICENSE" "$STAGE/usr/share/doc/saveme/LICENSE"
install -Dm644 "$ROOT_DIR/data/rclone-LICENSE" "$STAGE/usr/share/doc/saveme/rclone-LICENSE"
install -Dm644 "$ROOT_DIR/README.md" "$STAGE/usr/share/doc/saveme/README.md"

install -Dm755 "$ROOT_DIR/data/saveme" "$STAGE/usr/bin/saveme"
install -Dm755 "$ROOT_DIR/data/saveme-daemon" "$STAGE/usr/bin/saveme-daemon"
install -Dm755 "$ROOT_DIR/data/saveme-settings" "$STAGE/usr/bin/saveme-settings"

INSTALLED_SIZE="$(du -sk "$STAGE" | cut -f1)"
cat > "$STAGE/DEBIAN/control" <<EOF
Package: saveme
Version: ${VERSION}
Architecture: ${ARCH}
Maintainer: ${MAINTAINER}
Installed-Size: ${INSTALLED_SIZE}
Depends: gjs (>= 1.80), gir1.2-glib-2.0, gir1.2-gtk-4.0, gir1.2-adw-1, libglib2.0-bin, dbus-user-session, systemd, xdg-utils, curl
Section: utils
Priority: optional
Homepage: https://github.com/chrismaille/saveme
Description: One-way real-time sync and versioned backup for GNOME
 SaveMe mirrors a source folder to a destination in real time, or keeps a
 versioned backup of the source. It supports local folders, removable drives,
 Google Drive, Microsoft OneDrive, Dropbox, Nextcloud, S3 and pCloud through
 rclone.
 .
 This package contains the background daemon, the GTK settings application,
 the command-line tool, a pinned rclone binary and the GNOME Shell extension.
EOF

cat > "$STAGE/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database -q /usr/share/applications || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -q /usr/share/icons/hicolor || true
fi
cat <<'MSG'
SaveMe installed.

Open the app with:
  saveme
MSG
exit 0
EOF
chmod 755 "$STAGE/DEBIAN/postinst"

cat > "$STAGE/DEBIAN/postrm" <<'EOF'
#!/bin/sh
set -e
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database -q /usr/share/applications || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -q /usr/share/icons/hicolor || true
fi
exit 0
EOF
chmod 755 "$STAGE/DEBIAN/postrm"

mkdir -p "$ROOT_DIR/dist"
OUT="$ROOT_DIR/dist/saveme_${VERSION}_${ARCH}.deb"
dpkg-deb --build --root-owner-group "$STAGE" "$OUT"

STABLE="$ROOT_DIR/dist/saveme_${ARCH}.deb"
cp "$OUT" "$STABLE"

(
    cd "$ROOT_DIR/dist"
    sha256sum "saveme_${VERSION}_${ARCH}.deb" "saveme_${ARCH}.deb" \
        "saveme@chrismaille.github.io.shell-extension.zip" > SHA256SUMS
)

echo "Built $OUT"
echo "Stable asset: $STABLE"
echo "Checksums: $ROOT_DIR/dist/SHA256SUMS"
