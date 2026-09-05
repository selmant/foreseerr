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

## Remaining work

Not proven on a live Jellyfin yet. Track these before calling the plugin done:

- [ ] Install the zip on a real Jellyfin 10.10 host and exercise SSO, libraries, API key, health, `/Foreseerr` behind a reverse proxy, and File Transformation.
- [ ] Replace the fake Quick Connect fallback (initiate probe + `/Foreseerr/login`) with a real QC or password login path when HMAC mint fails.
- [ ] Either consume Foreseerr webhook payloads in `POST /ForeseerrPlugin/Webhook` (Moonfin-style) or stop auto-enabling a no-op agent.
- [ ] Copy Jellyfin `urlBase` into `jellyfin-host.json` so sidecar→JF works when Jellyfin is on a subpath.
- [ ] Bind an ephemeral loopback port (`127.0.0.1:0`) or detect collisions instead of always using `5055`.
- [ ] Apply the plugin/Moonbase TMDB key in `applyJellyfinHostFile`, or drop the field if Foreseerr should keep the bundled key only.
- [ ] Fill `manifest.json` `versions` (checksum + `sourceUrl`) so a third-party repo can install the zip.
- [ ] Build and smoke-test against Jellyfin 10.11, or document 10.10-only.
- [ ] Decide WebSocket/proxy streaming: HTTP-only `HttpClient` proxy will break any WS (or similar) Foreseerr uses.
- [ ] Expire or invalidate cached sidecar session cookies on logout / user change, not only on plugin restart.

Out of scope (plan): Android TV / official apps, official Jellyfin catalog, password replay as the happy path.
