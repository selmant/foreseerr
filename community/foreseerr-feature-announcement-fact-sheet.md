# Foreseerr Feature Announcement Fact Sheet

Updated: 2026-08-12

## Important subreddit note

`r/Softwarr` prohibits AI-generated posts and comments. This file is a factual
reference for the project owner, not copy intended for direct submission there.
Write any community post in your own words and verify the current subreddit
rules immediately before posting.

## Project links

- Foreseerr: <https://github.com/selmant/foreseerr>
- Foreseerr documentation: <https://selmant.github.io/foreseerr/>
- Foreseer Desktop: <https://github.com/selmant/foreseer-desktop>
- Jellium runtime fork: <https://github.com/selmant/jellium-desktop>
- Native Desktop guide: `docs/using-seerr/native-desktop.md`

## Positioning

Foreseerr is a personal Seerr fork that integrates SuggestArr-style discovery
and media workflows into the request application. It retains Seerr-compatible
configuration locations and its Jellyfin, Plex, Emby, Radarr, Sonarr, SQLite,
and PostgreSQL support.

The optional Foreseer Desktop companion loads the same hosted Foreseerr UI in a
native window. It does not replace Foreseerr's web app. Browser playback remains
the fallback whenever native playback is not available.

## Post-fork feature inventory

### Discovery and Trakt

- Per-user Trakt linking.
- Personalized recommendations.
- Trakt history, watchlist, liked lists, and public-list browsing.
- Discover-page rows, filters, sorting, anime handling, and hide-watched
  behavior.

### Ratings and personal media actions

- Consolidated external rating badges, including IMDb, Rotten Tomatoes,
  Metacritic, TMDB, Trakt, and MDBList sources where configured.
- Personal watched/unwatched actions and ratings on movie and TV cards.
- The same personal actions on movie and TV detail pages.
- Shared watched-state handling across card grids, details, seasons, and
  Library episode surfaces.
- Operation-specific Trakt and Jellyfin provider capabilities.
- Explicit partial-provider synchronization results rather than reporting an
  unsupported provider write as successful.

### Jellyfin Library

- Continue Watching, Recently Added, recently added episodes, Ready to Watch,
  and library search/browse views.
- Series and season panels with resume, next-unwatched, and rewatch choices.
- Direct Jellyfin episode watched/unwatched actions from Library views.

### TV and requests

- Individual TV episode requests, ranges, ongoing requests, specials, quotas,
  and Sonarr synchronization.
- Canonical TVDB episode-catalog support.

### Release calendar and Servarr management

- Unified Radarr/Sonarr release calendar with personal/all scopes, filters,
  notifications, date changes, and management actions.
- Servarr release search/selection, queue and activity inspection, grabs,
  manual import, command polling, and direct Arr links.

### Optional native desktop playback

- Foreseer Desktop native shell for Foreseerr.
- Same hosted Foreseerr UI in browser and desktop contexts.
- Supported Jellyfin items can use native Jellium/CEF/mpv playback in the same
  window and return to the prior Foreseerr route afterward.
- Browser fallback remains available for unsupported providers, trailers,
  unavailable native capability, and native failures.
- Short-lived, single-use, challenge-bound desktop bootstrap. The hosted page
  does not receive the linked Jellyfin access token.
- Foreseer Desktop owns the native protocol, secure bootstrap, product config,
  and Jellium revision pin. Jellium owns the generic CEF/mpv/compositor runtime.

## Claims to avoid until independently verified

- Do not call Desktop support stable on every platform. The documented support
  surface and packaging status are in the Foreseer Desktop README and release
  notes.
- Do not promise that every Jellyfin, Plex, Emby, or trailer play action uses
  native playback. The native path is presently for supported Jellyfin items;
  browser fallback is intentional.
- Do not claim that a native binary release has completed until its tagged
  packaging workflow and release assets are published.

## Useful owner-written-post outline

1. Briefly explain why the fork exists and what problem it solves for you.
2. Mention the few features you personally consider the most useful.
3. Explain that Foreseer Desktop is optional and does not replace browser use.
4. Link the three repositories and invite specific feedback or bug reports.
