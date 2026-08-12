---
title: Foreseerr v0.4.2 release notes
---

## Media-action consistency

- Adds watched and rating controls to movie and TV detail pages, matching the
  existing poster-card actions.
- Unifies Trakt and Jellyfin media-action capability handling across cards,
  detail pages, library episodes, and batch lists.
- Fixes episode watch-state writes being rolled back after successful API
  responses, and refreshes affected lists and status caches consistently.
- Makes provider partial-sync results visible and prevents unsupported
  Jellyfin rating actions from appearing successful.

## Upgrade notes

- Upgrades from Foreseerr `v0.4.1` are supported. Back up configuration before
  upgrading.
- Image: `ghcr.io/selmant/foreseerr:v0.4.2`.
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart` (`version` /
  `appVersion` `0.4.2` / `v0.4.2`).
