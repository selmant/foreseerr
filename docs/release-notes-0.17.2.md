---
title: Foreseerr v0.17.2 release notes
---

## Foreseerr desktop app

- The app no longer grows by about a gigabyte with every play. A 4K play left
  its freed memory with the app; it now goes back to the system a few seconds
  after the player closes. In testing, the app went from 1.8 GB back to about
  600 MB after a play.
- Use mpv 0.42 or newer from your distribution. Older libmpv leaks memory on
  its own, about 450 MB per hour of playback plus the stopped title's cached
  data, and only a newer mpv fixes that. See
  [Desktop App](using-seerr/native-desktop.md).
- Each Foreseerr release now carries the app as
  `foreseerr-desktop-linux-x64.tar.gz`, built from the app's repository when
  the release is made.

## Upgrade notes

- Upgrades from earlier stable Foreseerr releases, including `v0.17.1`, are
  supported on SQLite and PostgreSQL. Back up your configuration and database
  before upgrading; downgrades are not supported.
- No server changes and no new database migrations.
- Images: `ghcr.io/selmant/foreseerr:v0.17.2` and
  `selmantr/foreseerr:v0.17.2`.
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart`, chart `0.17.2`,
  app `v0.17.2`.

## Compatibility

- No API changes.
