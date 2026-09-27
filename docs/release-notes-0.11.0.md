---
title: Foreseerr v0.11.0 release notes
---

## Highlights

Foreseerr can now run inside Jellyfin. The new **Foreseerr for Jellyfin**
plugin (first release `0.1.0-alpha.1`, published from
[selmant/jellyfin-plugin-foreseerr](https://github.com/selmant/jellyfin-plugin-foreseerr)) bundles this version. Standalone Docker, Helm, and
binary installs are unchanged.

## Features

- Adds a Jellyfin plugin mode: Foreseerr runs as a loopback sidecar under
  `<Jellyfin>/Foreseerr/`, signs users in with their Jellyfin session, and
  imports the Jellyfin address, API key, libraries, and first administrator.
  See the [plugin guide](./using-seerr/jellyfin-plugin.md). The plugin is
  alpha: it can change at any time and has no backward compatibility between
  plugin versions.
- In plugin mode the web app adapts: **Back to Jellyfin** replaces Sign Out,
  Jellyfin connection settings are managed by the plugin, and local users,
  passwords, login methods, and web push are hidden.
- `GET /api/v1/settings/public` reports `pluginMode`.

## Fixes

- Mapping pack downloads no longer log every chunk once the decompressed size
  passes the compressed `Content-Length`, and no longer report progress above
  100%.
- The update check and **Settings → About → Releases** ignore Jellyfin plugin
  releases, so a plugin release is never shown as a Foreseerr update.
- Jellyfin "Play" links use same-origin paths when Foreseerr runs inside
  Jellyfin without a public URL.

## Upgrade notes

- Upgrades from Foreseerr `v0.1.0`, `v0.2.0`, `v0.2.1`, `v0.3.0`, `v0.4.x`,
  `v0.5.x`, `v0.6.x`, `v0.7.x`, `v0.8.x`, `v0.9.x`, and `v0.10.x` are
  supported. Back up your configuration before upgrading.
- No database migrations. `settings.json` gains a `plugin` section, used only
  in plugin mode.
- Image: `ghcr.io/selmant/foreseerr:v0.11.0` (also published to Docker Hub as
  `selmantr/foreseerr:v0.11.0`).
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart` (`version` /
  `appVersion` `0.11.0` / `v0.11.0`).
- Releases now also include `foreseerr-server.tar.gz`, the server tree for
  `launcher.js`.

## Compatibility

- No public API removals are included; `pluginMode` is a new optional field.
- Downgrades are not supported.
- Supported runtimes are Bun `>=1.4.0`, bundled SQLite, and PostgreSQL 16.
