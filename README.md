<p align="center">
<img src="./public/logo_full.svg" alt="Foreseerr" style="margin: 20px 0;">
</p>

**Foreseerr** is a personal fork of [Seerr](https://github.com/seerr-team/seerr) that folds SuggestArr-style discovery and media workflows into the app itself — Trakt, AniList, and MDBList browse, richer ratings, and more — without running a separate suggestion sidecar.

It keeps Seerr’s request pipeline, media-server integrations (Jellyfin / Plex / Emby), and Radarr/Sonarr support. Config paths stay Seerr-compatible (`CONFIG_DIRECTORY`, Docker `/app/config`).

**Jellyfin-first.** Foreseerr’s deeper features — Library / Watch Now, native Desktop playback, Jellyfin watched actions, and the Better Trakt bridge — are built and tested around Jellyfin. Plex and Emby remain supported for Seerr-style sign-in, library scans, requests, and availability. Cross-server features such as Direct Trakt, rating badges (e.g. MDBList), Discover, and the request pipeline work regardless of media server. Full Library and Desktop parity for Plex/Emby is not a current priority; please treat those as best-effort.

**Docs:** [selmant.github.io/foreseerr](https://selmant.github.io/foreseerr/)

## Optional Native Desktop Companion

[Foreseer Desktop](https://github.com/selmant/foreseerr-desktop) is the
optional native companion for Foreseerr. It loads the same hosted Foreseerr UI
in a desktop window and, for supported Jellyfin playback, uses the maintained
[Jellium runtime fork](https://github.com/selmant/jellium-desktop) to play in
that window. It is not required for normal browser use, requests, library
browsing, or any server-side feature.

The desktop binary never replaces this web application: browsers keep their
normal Jellyfin links, while a compatible desktop runtime adds native playback
only after the signed-in user's account is linked to Jellyfin. See the
[native desktop guide](docs/using-seerr/native-desktop.md) for the user-facing
behavior and [Foreseer Desktop](https://github.com/selmant/foreseerr-desktop)
for installation and release compatibility.

> [!NOTE]
> Foreseerr `v0.6.2` is the current stable release. Upgrades from `v0.1.0`, `v0.2.0`, `v0.2.1`, `v0.3.0`, `v0.4.x`, `v0.5.x`, and `v0.6.x` are supported. Alpha builds (`0.1.0-alpha.x`) are not a supported upgrade source — start from a fresh install or migrate from Seerr (see the migration guide). Back up your configuration before upgrading.

## Current Features (from Seerr)

- Full Jellyfin/Emby/Plex integration including authentication with user import & management.
- Support for **PostgreSQL** and **SQLite** databases.
- Movies, shows, and mixed libraries.
- Sonarr and Radarr integration with a customizable request system.
- Library scans, granular permissions, notification agents, watchlist & blocklist.
- Mobile-friendly UI.

## Foreseerr extras (on top of Seerr)

Shipped on top of Seerr (requests stay manual; no scheduled auto-request bot):

- **Trakt Discover** — recommendations, watchlist, history, and pin public or personal lists
- **AniList Discover** — trending, this season, popular, top 100, next season; linked watching / planning / completed and custom lists
- **MDBList** — IMDb / RT / Metacritic / Trakt community badges and filters, plus pin public lists as custom Discover rows
- Watched / unwatched / score actions (Trakt, optional AniList, Jellyfin where linked)
- Further SuggestArr-style Discover and settings work — not LLM recommendations

See [Discover](docs/using-seerr/discover.md) and [Integrations](docs/using-seerr/settings/integrations.md).

## Installation

Foreseerr is currently distributed as a Docker image. Docker and Docker Compose must be installed on the host; see the [Docker installation guide](https://docs.docker.com/get-docker/) if needed.

### Docker CLI

Create a persistent directory for Foreseerr’s configuration. The container runs as UID/GID `1000`, so make sure it can write to this directory:

```bash
mkdir -p ./foreseerr-config
sudo chown -R 1000:1000 ./foreseerr-config
```

Start the released image:

```bash
docker run -d \
  --name foreseerr \
  --init \
  --restart unless-stopped \
  -p 5055:5055 \
  -v "$(pwd)/foreseerr-config:/app/config" \
  ghcr.io/selmant/foreseerr:v0.6.2
```

Open `http://localhost:5055` and complete the setup wizard. Keep the `/app/config` volume when updating or recreating the container; it contains your database and settings.

To update, replace the image tag with the version you want, then recreate the container with the same volume mount. Back up `foreseerr-config` before updating.

### Docker Compose

The equivalent production-style Compose service is:

```yaml
services:
  foreseerr:
    image: ghcr.io/selmant/foreseerr:v0.6.2
    container_name: foreseerr
    init: true
    restart: unless-stopped
    ports:
      - "5055:5055"
    volumes:
      - ./foreseerr-config:/app/config
```

Start it with:

```bash
mkdir -p foreseerr-config
sudo chown -R 1000:1000 foreseerr-config
docker compose up -d
```

The image is published at `ghcr.io/selmant/foreseerr`. Prefer an explicit version tag (`v0.6.2`) or a stable alias (`latest`, `v0`, `v0.6`) rather than `develop`.

> Older pulls used `ghcr.io/selmant/seerr`. Point compose/CLI at `ghcr.io/selmant/foreseerr` going forward.

## Migrating from Seerr

Foreseerr uses Seerr-compatible config paths and database settings, so an existing Seerr configuration can be reused when replacing Seerr. Stop the existing instance first, back up its config/database, and do not run both instances against the same config directory or database.

See the [migration guide](docs/migration-guide.mdx) for the evergreen replacement procedure (clone-test, then same `/app/config` volume), supported upgrade sources, and what to do if your Seerr is newer than Foreseerr’s last upstream sync.

## API Documentation

With a running instance: http://localhost:5055/api-docs

## Upstream

Foreseerr tracks [seerr-team/seerr](https://github.com/seerr-team/seerr). This fork’s remote is [selmant/foreseerr](https://github.com/selmant/foreseerr).

## License

MIT (same as Seerr).
