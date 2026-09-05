# Foreseerr Jellyfin sidecar plugin

Third-party Jellyfin plugin. It starts the bun-compiled Foreseerr binary on `127.0.0.1`, reverse-proxies `/Foreseerr`, and signs users in with the current Jellyfin session. Official Jellyfin catalog will not accept this (native binary supervisor).

## Build

From the Foreseerr repo root:

```bash
mise install
bun run compile:plugin
plugin/build.sh
```

`mise.toml` pins Bun `1.4.1` and .NET 8. `compile:plugin` rebuilds the SPA with `base=/Foreseerr/` then compiles linux/windows binaries. `plugin/build.sh` publishes the C# plugin (via `mise exec -- dotnet` when mise is present) and copies binaries from `dist/bin/` into `plugin/dist/Foreseerr/sidecar/`.

Install `plugin/dist/Foreseerr-0.7.1.0.zip` (extract into `plugins/Foreseerr/`) or copy the `plugin/dist/Foreseerr` folder.

## Install

1. Dashboard → Plugins → Repositories → add a repo pointing at this plugin’s `manifest.json` when you host one, or copy the folder into Jellyfin’s plugins directory.
2. Restart Jellyfin.
3. Optional: install [File Transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) for a header button.
4. Dashboard → Plugins → Foreseerr: set **Public server URL** (https origin of Jellyfin). MDBList/TMDB keys are optional; Moonbase keys are imported when present.
5. Open Foreseerr. Jellyfin connection, libraries, and the first admin are loaded from this server. Configure Radarr/Sonarr inside Foreseerr.

Sidecar data lives under Jellyfin plugin configuration (`…/plugins/configurations/Foreseerr/foreseerr`). SQLite by default.

## Limits

Jellyfin Web (desktop) is the supported UI. Android TV / official apps do not load this SPA. Reverse proxies must forward `/Foreseerr` and `/ForeseerrPlugin`.
