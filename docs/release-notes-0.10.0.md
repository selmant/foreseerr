---
title: Foreseerr v0.10.0 release notes
---

## Highlights

Merges Seerr upstream `develop` into Foreseerr and ships Foreseerr-specific
request / watch-ahead fixes on top.

## Features

- Hides media that is already actively requested from Discover (and related
  settings), so browse rows stay focused on new titles.
- Adds a user lookup search box (username or email) in user management.
- Supports ntfy.sh notification tags and an optional Gotify embed poster.
- Identifies Foreseerr on outbound HTTP requests via a dedicated User-Agent.
- Accepts custom Plex metadata-provider GUID schemes in the library scanner.

## Fixes

- Lets a new watch-ahead request update the existing one instead of failing or
  duplicating; optional request fields are assigned only when set on replace.
- Hardens request lifecycle: serialize creation per requester, keep TV seasons
  with their owning request, reset orphaned seasons after deletion, enforce
  valid state transitions, skip empty seasons in all-season requests, and scope
  card download status to requested episodes.
- Fixes web push for multi-device and shared-browser subscriptions; drops a
  stale SQLite push-auth uniqueness constraint (migration).
- Remaps leftover Overseerr `DELETED` status values so imported rows are not
  read as blocklisted (database migration).
- Confirms scanner orphans against Arr before declining; refreshes avatars on
  Quick Connect login; finishes proxy error responses cleanly.
- UI / Headless UI upgrades for React 19 (radio, transitions, slideover
  backdrop).

## Upgrade notes

- Upgrades from Foreseerr `v0.1.0`, `v0.2.0`, `v0.2.1`, `v0.3.0`, `v0.4.x`,
  `v0.5.x`, `v0.6.x`, `v0.7.x`, `v0.8.x`, and `v0.9.x` are supported. Back up
  your configuration before upgrading.
- Includes database migrations `RemapOverseerrDeletedStatus` (SQLite +
  PostgreSQL) and `DropPushSubscriptionAuthUnique` (SQLite). Startup applies
  pending migrations automatically.
- Image: `ghcr.io/selmant/foreseerr:v0.10.0` (also published to Docker Hub as
  `selmantr/foreseerr:v0.10.0`).
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart` (`version` /
  `appVersion` `0.10.0` / `v0.10.0`).

## Compatibility

- No public API removals are included.
- Downgrades are not supported.
- Supported runtimes are Bun `>=1.4.0`, bundled SQLite, and PostgreSQL 16.
