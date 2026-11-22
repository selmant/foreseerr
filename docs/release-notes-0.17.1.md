---
title: Foreseerr v0.17.1 release notes
---

## Foreseerr desktop app

- The new [Foreseerr desktop app](https://github.com/selmant/foreseerr-player)
  shows your Foreseerr in a window of its own and plays Jellyfin media in that
  same window, with [Moonfin](https://github.com/Moonfin-Client/Moonfin-Core)'s
  player. Linux x64 for now. See [Desktop App](using-seerr/native-desktop.md).
- Inside the app, play buttons open the app's player instead of Jellyfin's web
  page. The first play signs the player in to Jellyfin as you, with your
  linked Jellyfin account, through a single-use ticket that is valid for two
  minutes. In a browser, play buttons work as before.
- Inside the app, Profile → Settings → **Player** shows the player's own
  settings (subtitles, audio, playback). The app's menu has **Quit**, Settings
  shows the app's Foreseerr address with **Change Address**, and Jobs & Cache
  clears the app's web cache.
- The old Foreseer Desktop companion is no longer supported: its desktop
  pairing endpoints are removed, so it can't play with this release. Its
  repository is archived; use the new app instead.

## Interventions: stalled downloads

- Downloads that Radarr or Sonarr report as stalled by the download client,
  such as a qBittorrent torrent with no connections, now show up in
  **Interventions**, with the client's reason. Automatic cleanup covers them
  after the grace period.
- Queue interventions now only cover titles Foreseerr added: a title needs a
  request that reached Radarr or Sonarr (approved, completed or failed) in the
  same quality, HD or 4K. Downloads of titles added in Radarr or Sonarr
  directly stay out of the inbox and out of automatic cleanup. Active ones
  resolve on the next sync without showing in History. The language checks on
  imported files are unchanged. See
  [Interventions](using-seerr/interventions.md).

## Upgrade notes

- Upgrades from earlier stable Foreseerr releases, including `v0.17.0`, are
  supported on SQLite and PostgreSQL. Back up your configuration and database
  before upgrading; downgrades are not supported.
- No new database migrations.
- Images: `ghcr.io/selmant/foreseerr:v0.17.1` and
  `selmantr/foreseerr:v0.17.1`.
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart`, chart `0.17.1`,
  app `v0.17.1`.

## Compatibility

- The existing Seerr API remains compatible.
- Added: `POST /player/pair-tickets`, `POST /player/pair-tickets/info` and
  `POST /player/pair-tickets/redeem`. Tickets live in memory, so a restart
  drops unused ones. A user can ask for 10 tickets a minute.
- Removed: `POST /desktop/auth-tickets` and
  `POST /desktop/auth-tickets/redeem`, used only by the old Foreseer Desktop
  companion.
