---
title: Jellyfin sidecar plugin
description: Run Foreseerr inside Jellyfin as a third-party plugin with SSO
---

# Jellyfin sidecar plugin

This is an **optional third-party** Jellyfin plugin for **Jellyfin 10.11 and newer**. It is not in the official Jellyfin catalog. It starts a bun-compiled Foreseerr process on `127.0.0.1`, reverse-proxies it at `/Foreseerr`, and signs the current Jellyfin Web user in without a password.

Standalone Docker and compiled binaries remain the supported ways to run Foreseerr on its own.

## What you get

- Foreseerr UI at `https://your-jellyfin/Foreseerr/`, including Jellyfin servers on a subpath such as `/jellyfin/Foreseerr/`
- Jellyfin hostname, libraries, API key, and first admin imported from this server (setup wizard skipped)
- Crash restart of the sidecar and a plugin page with its status and last error
- Optional header button if you install [File Transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation)
- Optional MDBList key on the plugin page, imported from Moonbase when present
- Better Trakt: if that plugin is loaded, Foreseerr defaults Trakt actions to the Jellyfin plugin

Radarr and Sonarr are still configured inside Foreseerr Settings. The plugin will not overwrite those.

## Install

1. Dashboard → Plugins → Repositories → add `https://github.com/selmant/foreseerr/releases/latest/download/foreseerr-jellyfin-manifest.json`.
2. Install **Foreseerr** from the catalog and restart Jellyfin. Jellyfin picks the build that matches its version.
3. Dashboard → Plugins → Foreseerr: set **Public server URL** to the HTTPS origin browsers use for Jellyfin.
4. Open Foreseerr as a Jellyfin administrator first; that account becomes the Foreseerr admin. Configure Radarr/Sonarr there.

To install manually, extract `foreseerr-jellyfin-10.11.zip` or `foreseerr-jellyfin-12.zip` from a GitHub Release into Jellyfin's `plugins/Foreseerr/` folder and restart Jellyfin.

Sidecar config and SQLite live under Jellyfin plugin configuration (`…/plugins/configurations/Foreseerr/foreseerr`) and survive plugin upgrades.

## Reverse proxies

Forward `/Foreseerr` and `/ForeseerrPlugin` to Jellyfin like any other path. Add your proxy to Jellyfin's **Known Proxies** so Jellyfin sees HTTPS requests; otherwise the Foreseerr session cookie is not marked `Secure`.

## Limits

Jellyfin Web (desktop browser) is the supported UI. Official Android TV / mobile apps do not load this SPA. The sidecar ships for Linux (x64, arm64) and Windows (x64).

Foreseerr's own CSRF protection is off in plugin mode. The plugin replaces it: the Foreseerr session is bound to the Jellyfin login, rechecked on every request, and write requests must come from the same origin.

Open implementation gaps are listed in [plugin/README.md](../../plugin/README.md#remaining-work).
