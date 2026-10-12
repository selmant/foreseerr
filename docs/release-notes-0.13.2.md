---
title: Foreseerr v0.13.2 release notes
---

## Fixes

- When Simkl refuses to link an account, **Link Simkl** now shows Simkl's
  reason instead of "Request failed with status code 400", and the server log
  records it. If a proxy between Foreseerr and Simkl refuses the request, the
  text of its error page is shown instead.
- Saving a Simkl Client ID in **Settings → Integrations** now checks the ID
  with Simkl. A wrong Client ID is rejected with Simkl's reason; before, any
  value was accepted. The Simkl health check logs why it failed.

## Upgrade notes

- Upgrades from earlier stable Foreseerr releases, including `v0.13.1`, are
  supported. Back up your configuration and database before upgrading.
- No new database migrations since `v0.13.1`.
- Image: `ghcr.io/selmant/foreseerr:v0.13.2` (also published to Docker Hub as
  `selmantr/foreseerr:v0.13.2`).
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart` (`version` /
  `appVersion` `0.13.2` / `v0.13.2`).

## Compatibility

- `POST /settings/simkl` answers `400` with Simkl's reason when Simkl rejects
  the Client ID. It used to answer `500`, or save the ID without checking it.
- No endpoints were added or removed.
- Downgrades are not supported.
- Supported runtimes are Bun `>=1.4.0`, bundled SQLite, and PostgreSQL 16.
