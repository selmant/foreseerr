# Title

Foreseerr v0.1.0 — Seerr fork with deep Trakt integration (mostly AI-assisted)

# Body

I run Seerr and live in Trakt for recommendations, lists, watch history, and scoring. I got tired of bouncing between Trakt and the request UI, so I forked Seerr into **Foreseerr** and wired Trakt into Discover and the title cards. **v0.1.0** is the first stable release.

### Honesty first
This was **heavily AI-assisted**. I decided what should exist, reviewed the diffs, tested on my own stack, and fixed what broke — but a large part of the code was written with AI tools. Treat it as a personal fork that scratched my itch, not as a second Seerr team.

### Why it exists
I wanted my Trakt account to drive discovery *inside* the request app:

- Browse what Trakt already knows about me (recs, lists, watchlist, history)
- Request from those views with the normal Seerr/Radarr/Sonarr flow
- Mark watched / rate titles without leaving Foreseerr
- Optionally enrich posters with more rating sources

Base app is still Seerr: Jellyfin / Plex / Emby, Radarr / Sonarr, SQLite or Postgres, users/permissions/notifications. Config stays Seerr-compatible (`CONFIG_DIRECTORY`, Docker `/app/config`), so a Seerr install can be reused if you want.

### Trakt features in v0.1.0
**Setup**
- Admin Trakt client ID/secret in Settings (also optional in the setup wizard)
- Each user links their own Trakt account via device code (`trakt.tv/activate`)
- Optional toggle for watched / rate actions on posters

**Discover**
- Trakt **recommendations**
- Trakt **watchlist**
- Trakt **history**
- **Personal + liked lists**, plus opening a list by URL / username / slug
- Home Discover sliders for those sources (and custom Trakt list sliders)
- Filters: movie / TV / anime, hide watched (and on recs: hide collected / hide watchlisted)
- Sorting: Trakt order / date added / release date
- Request media straight from those results

**On the title card / detail**
- Mark **watched / unwatched** on Trakt
- **Rate** 0.5–5 stars (maps to Trakt’s 1–10)
- Batch status fetch so list pages can show watched state without hammering Trakt one-by-one

### Other additions
- **MDBList-powered rating badges** (toggleable): TMDB, IMDb, Rotten Tomatoes, Metacritic, Trakt community — on posters and/or detail pages
- Discover filters by those external ratings (when MDBList is configured)
- Per-user Discover filter defaults
- Optional **instant request** on Radarr/Sonarr servers (one-click with server defaults)

### Explicitly not included
- No LLM / “AI recommend me something” features
- No scheduled auto-request bot from Trakt (requests stay manual)

### Links
- Release: https://github.com/selmant/foreseerr/releases/tag/v0.1.0
- Repo: https://github.com/selmant/foreseerr
- Docs: https://selmant.github.io/foreseerr/
- Image: `ghcr.io/selmant/foreseerr:v0.1.0` (also `selmantr/foreseerr`)

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

Personal project. Issues/PRs welcome. Happy to answer questions or take feedback.
