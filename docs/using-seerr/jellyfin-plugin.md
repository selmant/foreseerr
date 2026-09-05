---
title: Jellyfin sidecar plugin
description: Run Foreseerr inside Jellyfin as a third-party plugin with SSO
---

# Jellyfin sidecar plugin

This is an **optional third-party** Jellyfin plugin. It is not in the official Jellyfin catalog. It starts a bun-compiled Foreseerr process on `127.0.0.1`, reverse-proxies it at `/Foreseerr`, and signs the current Jellyfin Web user in without a password.

Standalone Docker and compiled binaries remain the supported ways to run Foreseerr on its own.

## What you get

- Foreseerr UI at `https://your-jellyfin/Foreseerr/`
- Jellyfin hostname, libraries, API key, and first admin imported from this server (setup wizard skipped)
- Crash restart of the sidecar and a plugin page with pid / last error
- Optional header button if you install [File Transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation)
- Optional MDBList / TMDB keys on the plugin page, imported from Moonbase XML when present
- Better Trakt: if that plugin is loaded, Foreseerr defaults Trakt actions to the Jellyfin plugin

Radarr and Sonarr are still configured inside Foreseerr Settings. The plugin will not overwrite those.

## Install

1. Build from a Foreseerr checkout: `mise install`, then `bun run compile:plugin`, then `plugin/build.sh`. Or use the `foreseerr-jellyfin-plugin.zip` from a GitHub Release when attached.
2. Extract into Jellyfin’s `plugins/Foreseerr/` folder (DLL plus the `sidecar/` binaries). Restart Jellyfin.
3. Dashboard → Plugins → Foreseerr: set **Public server URL** to the HTTPS origin browsers use for Jellyfin.
4. Open Foreseerr. Configure Radarr/Sonarr there.

Sidecar config and SQLite live under Jellyfin plugin configuration (`…/plugins/configurations/Foreseerr/foreseerr`).

Reverse proxies must forward `/Foreseerr` and `/ForeseerrPlugin`.

## Limits

Jellyfin Web (desktop browser) is the supported UI. Official Android TV / mobile apps do not load this SPA. CSRF is disabled in plugin mode because the plugin already authenticated the Jellyfin user and the sidecar only binds loopback.
