<p align="center">
<img src="./public/logo_full.svg" alt="Foreseer" style="margin: 20px 0;">
</p>

**Foreseer** is a personal fork of [Seerr](https://github.com/seerr-team/seerr) that folds SuggestArr-style discovery and media workflows into the app itself — Trakt browse, richer ratings, and more — without running a separate suggestion sidecar.

It keeps Seerr’s request pipeline, media-server integrations (Jellyfin / Plex / Emby), and Radarr/Sonarr support. Config paths stay Seerr-compatible (`CONFIG_DIRECTORY`, Docker `/app/config`).

## Current Features (from Seerr)

- Full Jellyfin/Emby/Plex integration including authentication with user import & management.
- Support for **PostgreSQL** and **SQLite** databases.
- Movies, shows, and mixed libraries.
- Sonarr and Radarr integration with a customizable request system.
- Library scans, granular permissions, notification agents, watchlist & blocklist.
- Mobile-friendly UI.

## Foreseer roadmap

Near-term additions on top of Seerr (see the Foreseer master plan):

- Trakt browse (recommendations, lists, watchlist) with manual requests
- Multi-source rating badges
- Trakt watched / unwatched / user score actions
- Further SuggestArr parity as Discover/settings — not auto-request jobs by default

AI / LLM recommendation features are explicitly out of scope unless reopened.

## Getting Started

### Docker Compose (dev)

```bash
docker compose up --build
```

App listens on port **5055**. Config lives under `./config` locally and `/app/config` in containers (unchanged from Seerr).

Postgres variant: `docker compose -f compose.postgres.yaml up --build`.

### From source

Follow upstream Seerr build docs, or:

```bash
pnpm install
pnpm build
pnpm start
```

### Kubernetes

```bash
helm install foreseer oci://ghcr.io/selmant/seerr/foreseer-chart
```

Images publish to `ghcr.io/selmant/seerr` (and optionally Docker Hub `selmant/foreseer` when credentials are configured).

## Migrating from Seerr / Overseerr / Jellyseerr

Point Foreseer at the same config volume (`/app/config`). Defaults and packaging are rebranded; on-disk layout and `CONFIG_DIRECTORY` semantics match Seerr so existing data can continue to be used.

Upstream Seerr migration notes: [docs.seerr.dev/migration-guide](https://docs.seerr.dev/migration-guide).

## API Documentation

With a running instance: http://localhost:5055/api-docs

## Upstream

Foreseer tracks [seerr-team/seerr](https://github.com/seerr-team/seerr). This fork’s remote is [selmant/seerr](https://github.com/selmant/seerr).

## License

MIT (same as Seerr).
