---
title: Foreseerr v0.13.1 release notes
---

## Changes

- Every card on **Discover → Sources** now has the same layout: **Explore**
  views, **Your account** views, and a field for opening a public list from a
  link wherever the service supports it.
- Trakt gains **Trending**, **Popular**, and **Anticipated** views. Like every
  Trakt view, they need a linked Trakt account.
- AniList gains **On hold** and **Dropped**, matching Simkl, and a **My lists**
  page for your status and custom lists. The page replaces the list dropdown
  on the Sources card.
- Anyone's public AniList anime list can be opened from an anilist.co link: a
  single list such as `anilist.co/user/<name>/animelist/Completed`, or a whole
  library from a profile link or username. No linked AniList account is needed.
- List link fields ask for a link instead of a "username/list-slug".

## Fixes

- The Trakt card no longer says public lists open without a linked account.
  Trakt rejects requests from apps without a linked account, so the card now
  says so.

## Upgrade notes

- Upgrades from earlier stable Foreseerr releases, including `v0.13.0`, are
  supported. Back up your configuration and database before upgrading.
- No new database migrations since `v0.13.0`.
- Image: `ghcr.io/selmant/foreseerr:v0.13.1` (also published to Docker Hub as
  `selmantr/foreseerr:v0.13.1`).
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart` (`version` /
  `appVersion` `0.13.1` / `v0.13.1`).

## Compatibility

- New endpoints: `/discover/trakt/{trending,popular,anticipated}` and
  `/discover/anilist/{paused,dropped}`.
- `/discover/anilist/list` now accepts `url` for a public list link. `url` was
  previously an undocumented alias for `name`; pass `name` for your own lists.
- Downgrades are not supported.
- Supported runtimes are Bun `>=1.4.0`, bundled SQLite, and PostgreSQL 16.
