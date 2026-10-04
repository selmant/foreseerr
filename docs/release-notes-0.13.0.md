---
title: Foreseerr v0.13.0 release notes
---

## Changes

- Discover sources and Trakt lists use compact layouts that fill gaps while
  keeping cards at their natural height. Trakt lists include search and clearer
  list metadata.
- More Discover, profile, request, and Library shelves end with a **See more**
  or **Browse all** card when a full browse page is available. Shelf navigation,
  keyboard focus, and labels are more consistent.
- Linked-service shortcuts connect Discover, profiles, and episode lists to
  Trakt, AniList, and Simkl. Watch tracking makes each service's state clearer
  and provides better comparison and retry controls.
- Library browsing, calendar planning, request options, and management pages
  have clearer navigation, actions, and empty states.
- Mapping now resolves external IDs through direct dataset lookups instead of
  an identity graph. Dataset matches respect the source format and season;
  manual corrections take priority over automatic and provider-supplied IDs.
- Mapping settings show **Datasets**, **Unmapped**, **Guessed**, and
  **Corrections**. Anime without a dataset match can use an exact TMDB title
  match or a known prequel's show; guesses are replaced when a dataset gains
  the ID. Corrections can be exported and imported.

## Upgrade notes

- Upgrades from earlier stable Foreseerr releases, including `v0.12.x`, are
  supported. Back up your configuration and database before upgrading.
- A new SQLite/PostgreSQL migration replaces the old mapping tables. Supported
  whole-title manual overrides targeting TMDB carry over as corrections.
  Dataset data and automatic matches are rebuilt; old season-specific overrides
  and custom episode rules do not carry over. Keep an old export or backup if
  you need to review those rules.
- Anime mapping datasets download at startup and refresh in the background
  unless disabled in **Settings → Mapping**. This changes the previous
  opt-in first-run behavior.
- Image: `ghcr.io/selmant/foreseerr:v0.13.0` (also published to Docker Hub as
  `selmantr/foreseerr:v0.13.0`).
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart` (`version` /
  `appVersion` `0.13.0` / `v0.13.0`).

## Compatibility

- The mapping administration API has changed with the mapping redesign;
  clients using the old graph, review, or episode-rule endpoints must update
  to the routes documented in `seerr-api.yml`.
- Downgrades are not supported. Restore the pre-upgrade backup to return to an
  earlier release.
- Supported runtimes are Bun `>=1.4.0`, bundled SQLite, and PostgreSQL 16.
