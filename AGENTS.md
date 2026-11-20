# SaveMe — repository rules

## Publishing is opt-in

Do **not** push, publish, release, upload, tag or otherwise make changes visible
outside the local machine until the user explicitly authorizes it in the current
conversation.

This includes, but is not limited to:

- `git push` to any remote;
- creating or moving git tags;
- uploading release assets to GitHub;
- uploading source packages to the Launchpad PPA;
- running the release workflow or any command that publishes a package;
- announcing a release.

Local commits and local builds are fine. When a task is finished, report the
local state and wait for authorization before publishing anything.

## Installations

- The PPA is the primary installation channel.
- `scripts/install.sh` is the fallback installer.
- `scripts/install-dev.sh` installs an isolated development copy and must never
  overwrite production files, configuration, state, daemon names or the
  production GNOME extension.
