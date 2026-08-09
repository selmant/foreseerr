---
title: Foreseerr v0.4.1 release notes
---

## Release correction

- Reissues the Foreseerr `v0.4.0` feature release with a corrected frozen dependency lockfile so reproducible CI and container builds can complete.

## Included features

- Personal release calendar and notifications.
- Jellyfin Library browsing, series panels, and watch-state controls.
- Hardened Foreseer Desktop authentication and playback integration.

## Upgrade notes

- Upgrades from Foreseerr `v0.1.0`, `v0.2.0`, `v0.2.1`, `v0.3.0`, and `v0.4.0` are supported. Back up your configuration before upgrading.
- Image: `ghcr.io/selmant/foreseerr:v0.4.1` (also published to Docker Hub as `selmantr/foreseerr:v0.4.1`).
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart` (`version` / `appVersion` `0.4.1` / `v0.4.1`).
