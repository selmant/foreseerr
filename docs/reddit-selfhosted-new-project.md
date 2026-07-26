# Where to post

Top-level **comment** (not a new submission) on this week’s megathread:

https://www.reddit.com/r/selfhosted/comments/1v4s7ok/new_project_megathread_week_of_23_jul_2026/

# Comment (copy-paste)

**Project Name:** Foreseerr

**Repo/Website Link:**
- Repo: https://github.com/selmant/foreseerr
- Release: https://github.com/selmant/foreseerr/releases/tag/v0.1.0
- Docs: https://selmant.github.io/foreseerr/

**Description:**
Foreseerr is a personal fork of [Seerr](https://github.com/seerr-team/seerr). I wanted my Trakt account to drive discovery *inside* the request UI instead of bouncing between Trakt and Seerr.

On top of Seerr (Jellyfin / Plex / Emby, Radarr / Sonarr, SQLite or Postgres, requests/users/notifications), v0.1.0 adds:

- Trakt Discover: recommendations, watchlist, history, personal/liked lists (also by URL / username / slug)
- Discover sliders for those Trakt sources, plus movie/TV/anime filters, hide watched (and on recs: hide collected / hide watchlisted), sorting
- Poster/detail actions: mark watched/unwatched on Trakt, rate 0.5–5★ (maps to Trakt 1–10)
- Optional MDBList rating badges/filters (TMDB, IMDb, RT, Metacritic, Trakt community)
- Per-user Discover filter defaults
- Optional instant request on Radarr/Sonarr servers
- Seerr-compatible config (`CONFIG_DIRECTORY`, Docker `/app/config`) so an existing Seerr config can be reused

Not included: LLM “recommend me something” features, and no scheduled Trakt auto-request bot (requests stay manual).

**Deployment:**
Released as `v0.1.0`. Docs: https://selmant.github.io/foreseerr/

Docker image: `ghcr.io/selmant/foreseerr:v0.1.0` (also `selmantr/foreseerr` on Docker Hub)

```yaml
services:
  foreseerr:
    image: ghcr.io/selmant/foreseerr:v0.1.0
    container_name: foreseerr
    init: true
    restart: unless-stopped
    ports:
      - "5055:5055"
    volumes:
      - ./foreseerr-config:/app/config
```

```bash
mkdir -p foreseerr-config
sudo chown -R 1000:1000 foreseerr-config
docker compose up -d
```

Open `http://localhost:5055`, finish setup, configure Trakt (admin client ID/secret), then link your Trakt account via device code.

Helm: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart`

**AI Involvement:**
Heavily AI-assisted. I steered the product decisions, reviewed diffs, tested on my own stack, and fixed what broke, but a large part of the implementation was written with AI coding tools. Treat it as a personal fork that scratched my itch — not a second Seerr team or a promise of enterprise support.
