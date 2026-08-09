<p align="center">
<img src="./public/logo_full.svg" alt="Foreseerr" style="margin: 20px 0;">
</p>

**Foreseerr** is a personal fork of [Seerr](https://github.com/seerr-team/seerr) that folds SuggestArr-style discovery and media workflows into the app itself — Trakt browse, richer ratings, and more — without running a separate suggestion sidecar.

It keeps Seerr’s request pipeline, media-server integrations (Jellyfin / Plex / Emby), and Radarr/Sonarr support. Config paths stay Seerr-compatible (`CONFIG_DIRECTORY`, Docker `/app/config`).

**Docs:** [selmant.github.io/foreseerr](https://selmant.github.io/foreseerr/)

> [!NOTE]
> Foreseerr `v0.4.0` is the current stable release. Upgrades from `v0.1.0`, `v0.2.0`, `v0.2.1`, and `v0.3.0` are supported. Alpha builds (`0.1.0-alpha.x`) are not a supported upgrade source — start from a fresh install or migrate from Seerr (see the migration guide). Back up your configuration before upgrading.

## Current Features (from Seerr)

- Full Jellyfin/Emby/Plex integration including authentication with user import & management.
- Support for **PostgreSQL** and **SQLite** databases.
- Movies, shows, and mixed libraries.
- Sonarr and Radarr integration with a customizable request system.
- Library scans, granular permissions, notification agents, watchlist & blocklist.
- Mobile-friendly UI.

## Foreseerr roadmap

Near-term additions on top of Seerr (see the Foreseerr master plan):

- Trakt browse (recommendations, lists, watchlist) with manual requests
- Multi-source rating badges
- Trakt watched / unwatched / user score actions
- Further SuggestArr parity as Discover/settings — not auto-request jobs by default

AI / LLM recommendation features are explicitly out of scope unless reopened.

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
  ghcr.io/selmant/foreseerr:v0.4.0
```

Open `http://localhost:5055` and complete the setup wizard. Keep the `/app/config` volume when updating or recreating the container; it contains your database and settings.

To update, replace the image tag with the version you want, then recreate the container with the same volume mount. Back up `foreseerr-config` before updating.

### Docker Compose

The equivalent production-style Compose service is:

```yaml
services:
  foreseerr:
    image: ghcr.io/selmant/foreseerr:v0.4.0
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

The image is published at `ghcr.io/selmant/foreseerr`. Prefer an explicit version tag (`v0.4.0`) or a stable alias (`latest`, `v0`, `v0.4`) rather than `develop`.

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
