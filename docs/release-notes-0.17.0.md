---
title: Foreseerr v0.17.0 release notes
---

## Sonarr: required audio and subtitle languages

- Each Sonarr server can require audio and subtitle languages, with separate
  lists for anime series. For example, you can require Japanese audio and
  English subtitles for anime. An empty anime list falls back to the standard
  one.
- After each import, Foreseerr checks the file's tracks. A file that has none
  of the required languages shows up in **Interventions** with what is missing
  and what the file has. Only embedded tracks count, not separate `.srt` files.
  A track with no language tag, or a file without media info, is never flagged.
- **Replace** deletes the file, blocklists the release in Sonarr, re-monitors
  the episodes and searches again, unless the server has search disabled.
  **Keep** leaves the file and stops flagging it.
- The Interventions "Blocklist history" tab is now **History** and also lists
  replaced and kept files.

Sonarr can already refuse releases by audio language with a Language custom
format. It has no subtitle rule, and it trusts the release name, so these
checks run on the downloaded file. See
[Interventions](using-seerr/interventions.md) and
[Services](using-seerr/settings/services.md).

## More from Sonarr 5

These use data that only Sonarr 5 sends. Sonarr 4 behaves as before.

- Seasons where Watch Ahead monitors single episodes now show as processing.
- Rejecting an intervention records the reason on Sonarr's blocklist entry,
  for example `Rejected in Foreseerr by <user>: <warning>`.
- The Manage panel has a new **Files in Sonarr** section. Each season shows
  its file count, qualities, release types and stuck grabs. Each episode shows
  its status and its audio and subtitle languages.
- An episode that was grabbed more than 6 hours ago but never downloaded is
  shown as stuck and logged once by the episode request sync.

## Discover list filters and sorts

- **MDBList** lists get content type, all of MDBList's sorts with a direction,
  title search, genres (any or all), a release range and rating ranges for
  eight sources. MDBList only applies rating filters for supporter accounts,
  so for other accounts Foreseerr checks ratings itself across the first
  1,000 titles of the list. MDBList descending sorts now really sort
  descending.
- **Trakt** lists get Trakt's full sort menu with a direction. VIP-only sorts
  are marked, and the filter bar shows whether your linked account has VIP.
  Links that used `added` or `released` keep their newest-first order.
- **AniList** lists, custom and status lists, get search, format, airing
  status, genres, country, a release-year range, eight sorts and score
  ranges.
- All three share one toolbar with grouped sorts, a filter count, keyboard
  navigation and a **Clear Filters** button when nothing matches.

## Adult content per user

- A new **Show Adult Content** option in each user's general settings. It is
  off by default, which keeps the previous behavior and now also hides adult
  titles from recommendations, similar titles, provider rows (Trakt, MDBList,
  AniList, Simkl, Plex watchlist) and AI Picks.
- Turned on, discover, search, person pages, recommendations, lists and AI
  Picks include adult titles.

## Documentation

- The Jellyfin plugin guide describes the plugin's settings page.

## Upgrade notes

- Upgrades from earlier stable Foreseerr releases, including `v0.16.0`, are
  supported on SQLite and PostgreSQL. Back up your configuration and database
  before upgrading; downgrades are not supported.
- Two new migrations: `user_settings.showAdultContent`, and `kind`,
  `episodeFileId` and `historyId` columns plus an index on
  `servarr_intervention`. Existing interventions become `queue` records and
  behave as before.
- Language checks do nothing until you set required languages on a Sonarr
  server. The first check after a start looks back 24 hours of imports.
- Building the backend from source now needs Rust 1.97 or newer.
- Images: `ghcr.io/selmant/foreseerr:v0.17.0` and
  `selmantr/foreseerr:v0.17.0`.
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart`, chart `0.17.0`,
  app `v0.17.0`.
- Server archives and Jellyfin-plugin runtimes are published for Linux x64,
  Linux arm64 and Windows x64, with `SHA256SUMS`.

## Compatibility

- The existing Seerr API remains compatible. Additions:
  `GET /discover/mdblist/filters`, new filter and sort parameters on the
  MDBList, Trakt and AniList list routes,
  `POST /servarr/interventions/{id}/replace` and `/keep`, four
  required-language fields on Sonarr settings, and `showAdultContent` on user
  settings.
- `POST /servarr/interventions/{id}/reject` returns `409` for language-check
  records.
