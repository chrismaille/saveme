<p align="center">
  <img src="assets/icon.png" width="128" alt="SaveMe icon">
</p>

<h1 align="center">SaveMe</h1>

<p align="center"><strong>One-way sync and versioned backups for GNOME.</strong></p>

<p align="center">
  <a href="https://github.com/chrismaille/saveme/actions/workflows/ci.yml"><img src="https://github.com/chrismaille/saveme/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/chrismaille/saveme/actions/workflows/release.yml"><img src="https://github.com/chrismaille/saveme/actions/workflows/release.yml/badge.svg" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg" alt="GPL-3.0-or-later"></a>
  <img src="https://img.shields.io/badge/GNOME-50-4a86cf.svg" alt="GNOME 50">
</p>

<p align="center"><a href="README.pt_BR.md">Português (Brasil)</a></p>

SaveMe is a GTK4/libadwaita application with a small user daemon that keeps a
folder in sync with a local disk or cloud destination, or creates a versioned
backup of it. It is designed for GNOME on Linux and integrates with the Shell
through an optional extension.

> **Project status:** pre-release. The core app, daemon, CLI, GNOME extension,
> recovery flow and cloud providers are implemented. Real-account validation
> for every provider is still in progress.

## Why SaveMe

- **Two clear modes.** Sync mirrors changes immediately. Backup keeps versions
  of files that are replaced or deleted.
- **Local and cloud destinations.** Use an external drive, OneDrive, Google
  Drive, Dropbox, Nextcloud/WebDAV, S3-compatible storage or pCloud.
- **Shares a destination safely.** Each job owns `SaveMe/<job-id>` inside a
  shared SaveMe base folder, so multiple jobs can use the same cloud account
  without overwriting each other.
- **Built-in safety.** The delete guard stops a run before it removes too many
  files. Empty or recreated sources are detected before the cloud is touched.
- **Real recovery.** Browse a SaveMe folder, import its jobs and restore files
  to a different local folder.
- **Native desktop integration.** Autostart, systemd user service, D-Bus,
  desktop notifications for backups and an optional GNOME Shell extension.
- **Translated.** The app, daemon and extension ship with 16 locales.

## Features

### Sync

Sync mirrors the selected source content to the destination. Creates, updates,
renames and deletions propagate. Sync jobs do not keep versions. A base folder
can be shared by several sync/backup jobs because each one gets its own
`SaveMe/<job-id>` folder.

### Backup

Backup copies changes to the destination and moves replaced or deleted files to
a version folder. Retention can keep versions for a number of days or forever.
A backup job can combine multiple sources. Real-time mode is intentionally not
available for backups.

### Restore and recovery

Open an existing SaveMe folder, inspect the backup manifests, import jobs and
restore a version to a local folder. Imported jobs stay disabled/manual until
you review their sources and destination.

### Scheduling and control

- Real-time, interval, weekly, monthly, dusk, startup and manual schedules.
- "At dusk" follows the GNOME night-light schedule automatically.
- Runs can wait until the computer is idle.
- Play, pause and stop controls per job. Stop also pauses recurrence until Play.
- Interrupted backups resume once when the daemon starts.
- Concurrent jobs are configurable; the default is 2.
- Startup catch-up runs schedules that were missed while the computer was off.

### Safety

- Delete guard configurable per job, directly from the job details.
- Empty-source and sudden-source-change protection.
- Local source/destination volume checks before a run.
- Local free-space and remote quota checks.
- Credentials are sanitized before logs are written or displayed.
- Log rotation with age and size limits.

## Supported services

**Sources and destinations:**

- Local folders and removable drives (resolved by volume UUID)
- Google Drive
- Microsoft OneDrive (personal and business)
- Dropbox
- Nextcloud and other WebDAV servers
- S3-compatible storage
- pCloud

iCloud is intentionally out of scope until Apple offers a stable API.

## Install

### Requirements

- Ubuntu 26.04 or a compatible GNOME 50 distribution
- GJS 1.88+, GTK 4.22+, libadwaita 1.9+
- rclone 1.60+ (the installer ships a pinned 1.76 binary; the PPA package
  uses the distribution's rclone)

### Recommended: PPA (Launchpad)

The PPA is the preferred installation because Ubuntu updates SaveMe with the
rest of the system.

```bash
sudo add-apt-repository ppa:chrismaille/saveme
sudo apt update
sudo apt install saveme
```

After that:

```bash
sudo apt upgrade
```

The PPA package installs the app, daemon, D-Bus service, CLI and the extension
zip. On first launch the app installs or refreshes the optional GNOME extension
and enables it automatically; no manual `gnome-extensions` command is needed.

Build and upload details: [docs/PPA.md](docs/PPA.md).

### Alternative: installer script

The installer script is a bootstrap for the GitHub `.deb` release. It is
useful for a first install, for testing a local build or when the PPA package
is not available. It is not machine-specific: it only uses the current user,
the host architecture and the standard user/session paths.

What the script does before installing:

1. Resolves the package:
   - `--deb PATH` if given;
   - a local `dist/saveme_<arch>.deb` when run from a checkout;
   - otherwise the latest GitHub release (or `--version X.Y.Z`).
2. Downloads the extension zip and verifies `SHA256SUMS` when available.
3. Stops the running app and the `systemd --user` daemon.
4. Calls `sudo` only for `apt-get install --reinstall` of the downloaded `.deb`.
5. Installs/updates the GNOME extension by default
   (`--no-extension`/`--app-only` skips it).
6. Enables and starts the user daemon.
7. Runs `saveme doctor` and writes a log to
   `~/.local/state/saveme-install.log`.

It does **not** erase jobs, configuration, accounts or history. Use
`--uninstall --purge --yes` only when you really want to remove that data.

```bash
curl -fsSL https://raw.githubusercontent.com/chrismaille/saveme/main/scripts/install.sh | sh
```

Useful options:

```bash
./scripts/install.sh --no-extension   # app + daemon only
./scripts/install.sh --app-only       # alias for --no-extension
./scripts/install.sh --dry-run        # show the plan without changing anything
./scripts/install.sh --remote         # force the GitHub release even with dist/
./scripts/install.sh --uninstall      # remove the package, keep user data
```

### From a local checkout

```bash
make test
make deb
./scripts/install.sh
```

Full instructions: [docs/INSTALL.md](docs/INSTALL.md).

### First run

1. Open **SaveMe** from the application menu.
2. Create a job, choose **Sync** or **Backup**.
3. Select the source and a SaveMe base folder.
4. Add a cloud account if needed.
5. Review the schedule and safety options, then save.
6. Use the Play button to run immediately, or let the schedule run it.

The GNOME extension shows job status and exposes Play/Pause/Stop from the top
panel. It is optional; the app and daemon work without it.

## Architecture

```text
GNOME Shell extension (GJS, optional) ──D-Bus──┐
                                               ├── saveme-daemon (GJS,
SaveMe Settings (GTK4/Adwaita) ────────────────┤    systemd --user) ── rclone
                                               │                         │
CLI (saveme) ──────────────────────────────────┘                         └── local / cloud
```

The daemon owns configuration, state, scheduling, watchers, logs and the
transfer lifecycle. The GTK app talks to it over D-Bus. The extension is a thin
UI and never owns job state.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full technical design.

## Development

```bash
make setup          # download the pinned rclone for development
make setup-hooks    # install pre-commit + commit-msg hooks
make lint           # pre-commit on every file
make test           # unit + integration tests
make tests          # unit + daemon E2E + extension/app E2E
make e2e-app        # GTK app smoke + memory soak
make verify         # lint + tests
make doctor         # check rclone, paths and volumes
make run ARGS="status"
make extension      # build the extension zip
make deb            # build the .deb
```

Development requirements: Python 3.11+, Node.js 22+ and
`desktop-file-utils` for lint; GNOME Shell 50 for the extension E2E.

## Releases

Versioning is automatic: commits follow
[Conventional Commits](https://www.conventionalcommits.org/), and
[semantic-release](https://semantic-release.gitbook.io/) creates the tag,
changelog and GitHub Release on every push to `main`.

See [docs/RELEASING.md](docs/RELEASING.md).

## Distribution

The supported installation path today is the `.deb` package installed by the
script, with a Launchpad PPA for automatic updates. AppImage is not a good fit
for the daemon, D-Bus, systemd user service and GNOME extension. Snap and
Flatpak are being evaluated before any store submission.

See [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md) for the comparison.

## Documentation

- [docs/SPEC.md](docs/SPEC.md) — product scope and acceptance criteria
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — technical decisions
- [docs/INSTALL.md](docs/INSTALL.md) — install, CLI and uninstall
- [docs/UBUNTU.md](docs/UBUNTU.md) — PPA and the official Ubuntu archive
- [docs/PPA.md](docs/PPA.md) — Launchpad PPA build and upload
- [docs/TESTING.md](docs/TESTING.md) — automated and manual test matrix
- [docs/LINTING.md](docs/LINTING.md) — pre-commit, linters and Omega rules
- [docs/RELEASING.md](docs/RELEASING.md) — commits and automatic releases
- [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md) — AppImage, Snap and Flatpak

## License

GPL-3.0-or-later. See [LICENSE](LICENSE). The bundled rclone binary is MIT
licensed; see `data/rclone-LICENSE`.
