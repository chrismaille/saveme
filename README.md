# SaveMe

**Source → Destination.** One-way real-time sync and versioned backup for GNOME.

SaveMe is a GNOME Shell extension backed by a small user daemon. It keeps a
destination folder or cloud remote in sync with a source folder, with two
deliberately different modes:

- **Sync** — mirrors the source to the destination in real time. Updates,
  renames and deletions propagate. No versions.
- **Backup** — copies changes to the destination and keeps previous versions of
  overwritten files. Deletions in the source do not delete the destination.

The heavy lifting (cloud APIs, OAuth, retries, checksums, rate limits) is done
by [rclone](https://rclone.org/). SaveMe owns the UX, scheduling, real-time
watching, safety rules, status, logs and restore flow.

## Supported destinations

- Local folders, including removable drives (resolved by volume UUID)
- Google Drive
- Microsoft OneDrive (personal and business)
- Dropbox

iCloud is intentionally out of scope until Apple offers a stable API.

## Architecture

```
GNOME Shell extension (GJS) ──D-Bus──┐
                                     ├── saveme-daemon (GJS, systemd --user) ── rclone
SaveMe Settings (GTK4/Adwaita) ──────┤                                          │
                                     └── config, state, logs, notifications     └── local / cloud
CLI (saveme) ────────────────────────┘
```

The extension is a thin UI. The daemon runs independently of the Shell, so
backups survive Shell restarts, logout and UI crashes.

## Install

Build and install the `.deb`:

```bash
make test
make deb
sudo apt install ./dist/saveme_*.deb
```

Then install the GNOME Shell extension from extensions.gnome.org, or locally:

```bash
gnome-extensions install --force /usr/share/saveme/extension.zip
gnome-extensions enable saveme@chrismaille.github.io
```

Full instructions: [docs/INSTALL.md](docs/INSTALL.md).

## Development

```bash
make setup          # download the pinned rclone for development
make test           # unit + integration tests
make doctor         # check rclone, paths and volumes
make run ARGS="status"
make extension      # build the extension zip
make deb            # build the .deb
```

Requirements:

- Ubuntu 26.04 / GNOME 50
- GJS 1.88+, GTK 4.22+, libadwaita 1.9+
- rclone 1.76+ (bundled with the SaveMe package; the Ubuntu archive version is
  too old)

## Documentation

- [docs/SPEC.md](docs/SPEC.md) — v1.0 scope and acceptance criteria
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — technical decisions
- [docs/INSTALL.md](docs/INSTALL.md) — install, CLI, uninstall
- [docs/TESTING.md](docs/TESTING.md) — automated and manual test matrix

## Status

The core, daemon, CLI, settings app and GNOME Shell extension are implemented.
Cloud OAuth and the manual acceptance matrix still need validation with real
accounts before the first public release.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE). The bundled rclone binary is MIT
licensed; see `data/rclone-LICENSE`.
