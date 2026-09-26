# Foreseerr Jellyfin sidecar plugin

Third-party plugin for **Jellyfin 10.11 and newer**. It starts the bun-compiled Foreseerr binary on `127.0.0.1` (OS-assigned port), reverse-proxies `/Foreseerr`, and signs users in with their Jellyfin session. The official Jellyfin catalog will not accept it (native binary supervisor).

## Builds

Each release ships one build per Jellyfin ABI:

| Jellyfin | Archive                        | Framework | Plugin version |
| -------- | ------------------------------ | --------- | -------------- |
| 10.11.x  | `foreseerr-jellyfin-10.11.zip` | net9.0    | `X.Y.Z.0`      |
| 12.x     | `foreseerr-jellyfin-12.zip`    | net10.0   | `X.Y.Z.1`      |

Jellyfin treats `targetAbi` as a minimum, so a 12 server also accepts the 10.11 build. The higher revision makes installs and auto-updates pick the matching build. `plugin/Build.props` owns this mapping; `scripts/merge-plugin-manifests.mjs` refuses to publish two builds with the same version.

## Build

From the Foreseerr repo root:

```bash
mise install
bun run compile:plugin                   # SPA with relative assets + sidecar binaries
plugin/build.sh 10.11                    # -> plugin/dist/jellyfin-10.11/
plugin/build.sh 12                       # -> plugin/dist/jellyfin-12/
bun scripts/merge-plugin-manifests.mjs   # -> plugin/dist/release/ (zips + repository manifest)
```

`mise.toml` pins Bun and the .NET 10 SDK, which also builds the net9.0 target. For a quicker local build, limit the sidecar targets: `bun run compile:plugin -- bun-linux-x64` then `plugin/build.sh 12 linux-x64`.

## Test

```bash
dotnet test plugin.tests/Foreseerr.Jellyfin.Tests.csproj -p:JellyfinTarget=10.11
dotnet test plugin.tests/Foreseerr.Jellyfin.Tests.csproj -p:JellyfinTarget=12
bun scripts/prove-jellyfin-plugin.mjs 10.11
bun scripts/prove-jellyfin-plugin.mjs 12
```

The 10.11 tests need the .NET 9 runtime (or `DOTNET_ROLL_FORWARD=Major`). The proof script uses Docker: it installs the built plugin into a disposable Jellyfin served under `/jellyfin`, then checks sidecar readiness, the subpath SPA and assets, SSO, CSRF, mint isolation, logout, and Jellyfin token revocation. Set `FORESEERR_TEST_FT_ARCHIVE` to a [File Transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) release zip to also check the header-button injection. Pull requests run both ABIs in `.github/workflows/jellyfin-plugin.yml`; the release workflow runs them before publishing.

## Local test environment

`bun run plugin:dev` runs a persistent Jellyfin in Docker with the current plugin build and [File Transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) installed:

```bash
bun run plugin:dev up 12                    # Jellyfin 12.1 on http://127.0.0.1:8096/web/
bun run plugin:dev up 10.11 --base /jellyfin  # Jellyfin 10.11.11 on http://127.0.0.1:8097/jellyfin/web/
bun run plugin:dev up 12 --build            # rebuild sidecar + plugin, then reinstall
bun run plugin:dev logs 12                  # Jellyfin and sidecar logs
bun run plugin:dev down 12                  # stop, keep data
bun run plugin:dev reset 12                 # stop and delete data
```

The first `up` completes the Jellyfin setup wizard and creates `admin` / `foreseerr` (administrator), `viewer` / `viewer` (regular user), and empty Movies and Shows libraries. Sign in to Jellyfin Web, then use the header button or open `<base>/Foreseerr/` directly. Drop media into `plugin/.dev/jellyfin-<abi>/media/{movies,shows}`. Every `up` reinstalls the plugin from `plugin/dist` and keeps the Jellyfin and Foreseerr data in `plugin/.dev/`. Jellyfin listens on `127.0.0.1` unless you pass `--bind 0.0.0.0`. Other options: `--port`, `--image jellyfin/jellyfin:<tag>`, `--no-file-transformation`.

## Settings

The dashboard page shows the sidecar status, the direct link, and one setting: **Public Jellyfin URL**, the address used for links in Foreseerr notifications. The origin (`https://jellyfin.example.com`) is enough; the plugin appends Jellyfin's base URL. When it is empty, the plugin uses an `all=` or `external=` entry from Jellyfin's Published Server URIs. With neither, Foreseerr keeps the Application URL and Jellyfin external URL set in its own settings, and "Play on Jellyfin" links fall back to same-origin paths. Clearing the plugin field removes only values the plugin set.

Everything else comes from Jellyfin on each sidecar start: server name, loopback address, base URL, API key, libraries, locale, and the first administrator. If Better Trakt is loaded and Foreseerr has no direct Trakt app, Trakt actions default to Better Trakt. Radarr, Sonarr, notifications, and other integrations are configured in Foreseerr.

## Security model

- The sidecar binds loopback only and rejects every request without the per-install shared secret, including health checks. The secret and the Jellyfin API key are stored in the plugin XML but are not sent to the dashboard page.
- `POST /Foreseerr/sso` (Jellyfin-authenticated) mints a Foreseerr session over a loopback call carrying that secret. The browser only gets an opaque `HttpOnly`, `SameSite=Strict` ticket cookie scoped to `<base>/Foreseerr`; Jellyfin tokens and the sidecar session cookie never reach JavaScript.
- Each Jellyfin login holds one ticket, and signing in again rotates it. A user can hold tickets for 10 logins at once; older ones are dropped, and other users are never affected. Tickets expire after 8 hours.
- Pages and API requests revalidate the bound Jellyfin token every time, so Jellyfin logout, token revocation, or disabling the user ends the Foreseerr session. Static files and images reuse a validation for up to 30 seconds.
- A page request without a ticket gets a sign-in page. It reads this server's entry from Jellyfin Web's `jellyfin_credentials`, calls `/Foreseerr/sso`, and reloads the requested path, so notification links and bookmarks work. It runs under a nonce-based CSP.
- Foreseerr's own CSRF middleware is off in plugin mode. The proxy instead requires unsafe methods to be same-origin (`Sec-Fetch-Site`, falling back to `Origin`), strips browser credential and forwarding headers, and never exposes the mint endpoint.
- The first plugin login must be a Jellyfin administrator. On every sign-in, Jellyfin administrators get Foreseerr's ADMIN permission. If Jellyfin later removes administrator, the plugin takes back only an ADMIN it granted (the user gets back their other permissions, or the defaults); ADMIN granted in Foreseerr stays. Settings record which grants and URLs came from the plugin.

## Limits

- Jellyfin Web (desktop) is the supported UI. Android TV and the official mobile apps do not load this SPA.
- Without [File Transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation), there is no header button; users open `<base>/Foreseerr/` directly (the dashboard page shows the link).
- Web push notifications are off under the plugin's base path.
- Sidecar binaries exist for linux-x64, linux-arm64, and windows-x64 only.
- Reverse proxies must forward `/Foreseerr` and `/ForeseerrPlugin`. Configure Jellyfin's Known Proxies so it sees HTTPS; otherwise the ticket cookie is not marked `Secure`.
- WebSocket upgrades are not proxied. Foreseerr does not use them.

## Remaining work

- [ ] Run the tagged release workflow once and install from the published repository manifest. The plugin release path has not run on CI yet.
- [ ] Exercise a real TLS-terminating reverse proxy.
- [ ] Automate the browser flow (header button, click-through, dashboard page). It was checked by hand in headless Chromium on 10.11.11 and 12.1; the proofs are HTTP-only.

Out of scope: Android TV / official apps, the official Jellyfin catalog, password replay.
