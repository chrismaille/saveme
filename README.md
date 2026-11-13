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

From a local checkout:

```bash
make test
make deb
./scripts/install.sh
```

The installer stops an existing daemon, reinstalls the `.deb`, updates the GNOME
Shell extension and starts the daemon again. Use `--dry-run` to see the plan.

After the GitHub releases are published, the one-liner is:

```bash
curl -fsSL https://raw.githubusercontent.com/chrismaille/save_me/master/scripts/install.sh | sh
```

Full instructions: [docs/INSTALL.md](docs/INSTALL.md).

## Development

```bash
make setup          # download the pinned rclone for development
make setup-lint     # create .venv + install Node lint tools
make lint           # pre-commit on every file, staged or not
make test           # unit + integration tests
make tests          # unit + daemon E2E + extension E2E
make verify         # lint + tests
make doctor         # check rclone, paths and volumes
make run ARGS="status"
make extension      # build the extension zip
make deb            # build the .deb
```

Requirements:

- Ubuntu 26.04 / GNOME 50
- GJS 1.88+, GTK 4.22+, libadwaita 1.9+
- Python 3.11+ and Node.js 22+ for lint
- rclone 1.76+ (bundled with the SaveMe package; the Ubuntu archive version is
  too old)

Lint details, hooks and the Omega architecture rules: [docs/LINTING.md](docs/LINTING.md).

## Documentation

- [docs/SPEC.md](docs/SPEC.md) — v1.0 scope and acceptance criteria
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — technical decisions
- [docs/INSTALL.md](docs/INSTALL.md) — install, CLI, uninstall
- [docs/TESTING.md](docs/TESTING.md) — automated and manual test matrix
- [docs/LINTING.md](docs/LINTING.md) — pre-commit, linters and Omega rules

## Status

The core, daemon, CLI, settings app and GNOME Shell extension are implemented.
Cloud OAuth and the manual acceptance matrix still need validation with real
accounts before the first public release.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE). The bundled rclone binary is MIT
licensed; see `data/rclone-LICENSE`.
