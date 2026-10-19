---
title: Foreseerr v0.14.0 release notes
---

## Simkl

- Simkl linking works with Simkl's AUTH V2. Simkl now only issues V2 apps,
  and a V2 Client ID could neither be saved nor linked; Foreseerr spoke only
  the older PIN flow, which Simkl retires around April 2027.
- Foreseerr ships its own Simkl app, as Simkl recommends, so nothing needs to
  be registered on Simkl. **Settings → Integrations → Simkl** has an **Enable
  Simkl** switch instead of a Client ID field. New installs start with Simkl
  on. Upgraded installs that had a Client ID stay on; the others stay off until
  an administrator turns Simkl on.
- An install with its own Simkl Client ID keeps it, and its linked accounts.
  Its Simkl settings offer **Switch to Foreseerr's Simkl App**; switching asks
  first, because linked users must link Simkl again afterwards.
- Each user still links their own account from **Profile → Linked Accounts**,
  and their requests count against their own Simkl allowance. Access tokens
  renew automatically, and unlinking asks Simkl to revoke the access.
- Library sync follows Simkl's sync guide: it checks what changed first and
  downloads only that. Rating changes and removed ratings are picked up, and
  episode status no longer downloads the whole watch history on every request.

## Fixes

- Watch-ahead requests no longer monitor an episode again after it was
  unmonitored outside Foreseerr before it was downloaded, for example by
  Maintainerr. Request cards, the request list and request details show a
  **Removed** badge for such episodes, and **Inactive** for a request whose
  whole watch-ahead window was removed. Monitoring the episodes in Sonarr
  brings them back.
- In Discover's edit mode, Simkl sliders show their names instead of
  "Unknown Slider".
- The See More card at the end of a slider previews titles that come after the
  row instead of repeating its last posters.
- The Quick Connect dialog shows its large code again, and the scrollbar in
  the Quick Connect, Simkl and Trakt linking dialogs no longer flickers.

## Upgrade notes

- Upgrades from earlier stable Foreseerr releases, including `v0.13.4`, are
  supported. Back up your configuration and database before upgrading.
- New database migrations: `AddWatchAheadMonitorTracking`,
  `AddSimklRefreshToken` and `AddSimklWatchedEpisodes`. The last one makes
  each user's Simkl library resync once. Settings migration
  `0015_simkl_builtin_client` sets the new Simkl switch.
- Image: `ghcr.io/selmant/foreseerr:v0.14.0` (also published to Docker Hub as
  `selmantr/foreseerr:v0.14.0`).
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart` (`version` /
  `appVersion` `0.14.0` / `v0.14.0`).

## Compatibility

- **Breaking:** `POST /api/v1/settings/simkl` refuses a new custom `clientId`
  with `400`; only `''` (switch to Foreseerr's app) or the install's existing
  ID are accepted. It also accepts `enabled`, which `GET` now returns.
- Request responses add the read-only `monitoredAt`, `unmonitoredAt` and
  `watchAheadInactiveAt` fields.
- Downgrades are not supported.
- Supported runtimes are Bun `>=1.4.0`, bundled SQLite, and PostgreSQL 16.
