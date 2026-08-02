# Library series UX — seasons, next-up Play, recent episodes

Date: 2026-08-02  
Status: approved for planning  
Owner: SeerrSuggestArr (Foreseer web Library). Native desktop remains play-only via `jelliumHost.playItem`.

## Problem

Library movies work as expected. Series feel wrong because most shelves attach a **series-level** Jellyfin id to Play, while Continue Watching already uses **episode** ids. There is no in-Library season/episode browser, and “Recently Added” for TV shows new **series**, not newly arrived **episodes**.

## Goals

1. Series **Play** behaves like Jellyfin: resume in-progress episode, else next unwatched, else rewatch from S1E1.
2. Series **card click** opens an in-Library **slide-over** with seasons and episodes (not `/tv/{id}`).
3. Slide-over includes **View details** → existing `/tv/{tmdbId}` (same escape hatch movies get via their detail page).
4. Keep **Recently Added** as movies + new series; add **Recently Added Episodes**.
5. No native/Jellium protocol change unless Play regressions force it.

## Non-goals

- Rewriting the public `/tv/{id}` detail page into a Library browser.
- Emby/Plex feature parity beyond current Library media-server gating.
- Episode search-by-title in Library search (search stays Movie/Series names).
- Changing Continue Watching semantics (already episode-based).

## Approach

Server-resolved play targets + Library slide-over (approach 1).

- Shelf APIs expose enough ids for Play and panel open.
- UI uses `playItemId ?? jellyfinItemId` for Play.
- Panel loads seasons/episodes from new Library endpoints using the user-linked Jellyfin token.

## Product behavior

### Shelves

| Shelf id | Title | TV behavior |
| --- | --- | --- |
| `continue` | Continue Watching | Unchanged: episode cards; Play = that episode |
| `recent` | Recently Added | Movies + new series (show poster). Series Play = next/resume/rewatch episode |
| `recent-episodes` | Recently Added Episodes | **New:** episode cards; Play = that episode |
| `forgotten` | Ready to Watch | Show poster; Play = next/resume/rewatch episode |
| browse / search | Available / Search | Series same as Ready; click opens panel |

### Interactions

```
Series card [Play]     → playItem(playItemId)
Series card [poster]   → LibrarySeriesPanel
Panel [View details]   → /tv/{tmdbId}
Episode row [Play]     → playItem(episodeId)
Movie card             → unchanged (Play = movie; click = /movie/{id})
```

### Next/resume resolution (series Play)

Ordered rules:

1. If the user has an in-progress episode for that series → that episode.
2. Else the next unwatched episode in season/episode order → that episode.
3. Else (all watched) → first episode of the first **non-special** season (`IndexNumber >= 1` when available; otherwise first listed season), labeled `Rewatch S1E1` (or the actual season/episode numbers).

Resolution runs on the Foreseer server against Jellyfin user data. Optional use of Jellyfin NextUp is allowed if it matches these rules; otherwise compute from resume + episode listing.

**Episode-row cards** (Continue Watching, Recently Added Episodes): Play = that episode. Poster/body click opens `LibrarySeriesPanel` for `jellyfinSeriesId` when known (same panel as series cards).

## Data model

Extend `LibraryTitle` (additive, backward-compatible):

```ts
interface LibraryTitle {
  mediaId?: number;
  tmdbId?: number;
  mediaType: 'movie' | 'tv';
  /** Primary Jellyfin id (movie, episode, or series depending on shelf row). */
  jellyfinItemId: string;
  /** What Play should send. For series rows this is the resolved episode id. */
  playItemId?: string;
  /** Series id when the row is a series or an episode. Used to open the panel. */
  jellyfinSeriesId?: string;
  title: string;
  subtitle?: string; // e.g. "Up next S3E2", "S3E2 · Show", "Rewatch S1E1"
  overview?: string;
  mediaUrl?: string;
  status?: MediaStatus;
  progressPercent?: number;
}
```

Play rule in UI: `playItemId ?? jellyfinItemId`.

`LibraryShelf.id` gains `'recent-episodes'`.

### Panel payloads (new)

```ts
interface LibrarySeriesSeason {
  jellyfinSeasonId: string;
  name: string;
  indexNumber?: number;
  episodeCount?: number;
}

interface LibrarySeriesDetailResponse {
  jellyfinSeriesId: string;
  tmdbId?: number;
  title: string;
  playItemId?: string; // same resolver as shelves
  subtitle?: string;
  seasons: LibrarySeriesSeason[];
  code?: 'not_linked' | 'server_unreachable' | 'unsupported_media_server' | 'not_found';
}

interface LibraryEpisode {
  jellyfinItemId: string;
  name: string;
  indexNumber?: number;
  parentIndexNumber?: number;
  subtitle?: string; // SxxExx
  overview?: string;
  progressPercent?: number;
  watched?: boolean;
}

interface LibrarySeasonEpisodesResponse {
  jellyfinSeriesId: string;
  jellyfinSeasonId: string;
  episodes: LibraryEpisode[];
  code?: 'not_linked' | 'server_unreachable' | 'unsupported_media_server' | 'not_found';
}
```

## API

All routes require the same auth as existing `/api/v1/library/*` and use the **user-linked** Jellyfin token (not admin).

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/library/watch-now` | Existing shelves + `recent-episodes`; series rows include resolved `playItemId` / `jellyfinSeriesId` |
| GET | `/api/v1/library/available` | Series rows include resolved play fields |
| GET | `/api/v1/library/search` | Same |
| GET | `/api/v1/library/series/:jellyfinSeriesId` | Series header + seasons for slide-over |
| GET | `/api/v1/library/series/:jellyfinSeriesId/seasons/:seasonId/episodes` | Episode list for selected season |

Must register every new path in `seerr-api.yml` / OpenAPI (avoid validator 404s).

### Jellyfin helpers

- Reuse `getResumeItems`, `getSeasons`, `getEpisodes`.
- Add or extend Latest helper with `IncludeItemTypes: 'Episode'` for `recent-episodes`.
- Keep Latest `Movie,Series` for the existing `recent` shelf.
- Centralize next/resume/rewatch resolution in `server/lib/library.ts` (or a small helper next to it) so shelves and panel share one implementation.

## UI

### Library page

- Render new shelf between Recently Added and Ready to Watch.
- Series cards show resolver subtitle when present.
- Episode cards prefer **series poster** art for visual consistency unless episode image is already returned cheaply.

### TitleCard `libraryMode` (TV)

- Play uses `playItemId ?? jellyfinItemId`.
- Body click opens `LibrarySeriesPanel` with `jellyfinSeriesId` (from row or series id itself); do not navigate to `/tv/{id}`.
- Movies unchanged.

### `LibrarySeriesPanel`

Slide-over / drawer:

- Header: show title, Play next (uses resolved `playItemId`), **View details** → `/tv/{tmdbId}` when `tmdbId` known.
- Season chips from series detail response.
- Episode rows: title, SxxExx, watched/progress, per-row Play.
- Errors: reuse Library codes with retry; empty season shows a short empty state.
- Closing the panel returns to the same Library scroll position.

## Architecture boundaries

```
Library UI
  → /api/v1/library/* (Foreseer)
    → Jellyfin user API (linked token)
  → window.jelliumHost.playItem(requestId, episodeOrMovieId)  // native only
```

- Foreseer web owns shelf composition, next-up policy, and panel UX.
- Jellium owns playback of a concrete item id only.
- Do not surface Jellyfin Web for browsing.

## Error handling

| Condition | Behavior |
| --- | --- |
| No linked Jellyfin | Existing `not_linked` on shelves; panel same |
| Jellyfin unreachable | `server_unreachable` |
| Unknown series id | `not_found` in panel |
| Resolver finds no episodes | No Play / disabled Play; panel still lists empty seasons if any |

## Testing

- OpenAPI contract tests for new routes and extended shelf id.
- Unit tests for next/resume/rewatch resolver.
- Mapping tests: series shelf items have episode `playItemId`; episode shelf items play themselves.
- Manual smoke (web + desktop): resume, next, rewatch S1E1, panel season switch, episode Play, View details, recent-episodes shelf, unlinked error.

## Rollout

1. Implement on SeerrSuggestArr `develop`.
2. Deploy via homelab `foreseer-src` pin.
3. Note in `foreseer-desktop/docs/integration-plan.md`: Library series Play uses resolved episode ids; panel is web-owned.

## ASCII reference

```
Library
├─ Continue Watching
├─ Recently Added              (movies + new series)
├─ Recently Added Episodes     (NEW)
├─ Ready to Watch
└─ Browse / Search

Click series poster
        │
        ▼
┌─ Show title ──────────────── X ┐
│ [Play next]  [View details]    │
│ Seasons: 1  2  [3]  4          │
│ S3E1  …  watched               │
│ S3E2  …  resume   [Play]       │
│ S3E3  …           [Play]       │
└────────────────────────────────┘
```
