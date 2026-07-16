# Discover Filter Defaults (Per-User)

**Date:** 2026-07-16  
**Status:** Approved for implementation planning  
**Scope:** Per-user global Discover browse filter defaults, replacing the Linked Accounts “Hide watched” toggle.

## Problem

Users want personal Discover defaults (especially hide watched) applied every visit without re-checking filters. Today only `UserSettings.hideTraktWatched` is persisted, and it lives under Linked Accounts. Other browse filters are URL/session-only.

## Goals

- Persist a full **browse-mode** Discover filter default set per user.
- Apply those defaults on every FilterSlideover surface (Movies, TV, Trending, Trakt browse/recs/watchlist/lists).
- Session override only: Discover URL/query wins; clearing a filter for the session does not rewrite saved defaults.
- New **User Settings → Discover** page as the sole editor for these defaults.
- Remove the Linked Accounts “Hide watched” toggle and migrate `hideTraktWatched` into the new store.

## Non-goals

- Auto-persist when changing FilterSlideover.
- “Save as my defaults” from Discover.
- Instance-wide / admin Request Filters as user Discover defaults.
- Full-mode-only filters: `sortBy`, studio, keywords, runtime, certification, watch providers/region, status.
- Separate movie vs TV genre preference sets (v1 uses one shared `genre` string).

## Architecture

### Storage

Add nullable JSON column on `UserSettings`:

- `discoverFilterDefaults`

Validated with Zod as a subset of Discover browse filter keys (see schema below). `null` / `{}` means no defaults.

### Migration

1. For each row with `hideTraktWatched = true`, set `discoverFilterDefaults` to include `ignoreWatched: true` (merge if column already present in a later migration path; first migration creates empty/null then copies).
2. Drop `hideTraktWatched`.
3. Remove Linked Accounts UI toggle and Trakt preferences API field for `hideWatched`.

### API

- `GET /api/v1/user/:id/settings/discover` → current defaults object (and empty object if unset).
- `POST /api/v1/user/:id/settings/discover` → replace entire defaults object (not sparse patch). Invalid body → 400.
- Auth/permissions: same as other user settings (self, or admin editing another user).

Update OpenAPI accordingly. Remove `hideWatched` from Linked Accounts Trakt preferences responses/requests.

### Apply rule

Shared helper (name illustrative): `resolveDiscoverFilterDefaults(userDefaults, query) → effectiveFilters`.

For each participating key:

1. If the query/URL explicitly sets the key → use that value (including explicit off, e.g. `ignoreWatched=false`).
2. Else if user defaults define the key → use the default.
3. Else → unset / falsey as today.

Apply on:

- **Server:** Discover / Trakt browse routes that already resolve hide-watched and browse filters (generalize `resolveIgnoreWatched` into this helper or call it from inside).
- **Client:** FilterSlideover + filter preparation for SWR/query building — merge defaults for missing keys so UI checkboxes/fields reflect effective state without rewriting the URL until the user interacts.

URL remains session source of truth after the user changes filters. Defaults are not written back from Discover.

### Settings UI

- Add User Settings nav item **Discover** following existing route patterns (`/settings/discover` under profile/user settings).
- Page reuses browse FilterSlideover-style controls plus hide toggles (`ignoreWatched`, `ignoreCollected`, `ignoreWatchlisted`).
- Save replaces the full defaults object via POST.
- Delete Linked Accounts “Hide watched” block entirely.

## Defaults schema (v1)

Persist only keys that browse FilterSlideover already understands:

| Group | Keys |
|--------|------|
| Hide | `ignoreWatched`, `ignoreCollected`, `ignoreWatchlisted` |
| Language | `language` |
| Dates | `primaryReleaseDateGte`, `primaryReleaseDateLte`, `firstAirDateGte`, `firstAirDateLte` |
| Genres | `genre` (comma-separated TMDB genre ids, same as Discover URL) |
| TMDB quality | `voteAverageGte`, `voteAverageLte`, `voteCountGte`, `voteCountLte` |
| External ratings | `imdbRatingGte/Lte`, `imdbVotesGte/Lte`, `rtCriticsGte/Lte`, `rtAudienceGte/Lte`, `metacriticGte/Lte`, `traktRatingGte/Lte`, `includeNoRating` |

**Genres:** one shared `genre` string. Movie-only / TV-only pages ignore inapplicable ids; mixed Trakt browse keeps matching titles.

**JSON value types (explicit):**

- Hide flags + `includeNoRating`: JSON booleans (`true` / `false`). Absent key means “no default”; `false` is a real default that forces the filter off when query omits the key.
- All other keys: strings in the same shape as Discover URL query values (`genre`, dates, rating floors, `language`).

Resolve helper coerces into existing server/client parsers. Reject unknown keys on write.

## Surfaces

Defaults apply everywhere FilterSlideover is used:

- Discover Movies, Discover TV, Trending
- Trakt recommendations, watchlist, lists, and other Trakt browse surfaces that expose these filters

Hide collected / watchlisted remain Trakt-recs-oriented in the UI (only shown where those controls already exist) but may still be stored in defaults for when those surfaces are open.

## Edge cases

- **No Trakt link:** defaults still save; watched/collected/watchlisted filtering no-ops or behaves as today until sync/data exists.
- **Invalid JSON in DB:** treat as empty defaults; log; do not 500 Discover.
- **Admin editing another user:** allowed like General settings.
- **Explicit session clear:** FilterSlideover “clear” / uncheck must set explicit query off values so defaults do not immediately re-apply mid-session (same pattern as current `ignoreWatched=false`).

## Testing

- Zod schema: valid browse defaults accepted; unknown keys / bad types rejected.
- Resolve helper: query wins; omit → default; explicit false/clear beats default.
- Migration: `hideTraktWatched=true` → `ignoreWatched` in JSON; `false` → empty/null defaults.
- Route: GET/POST discover settings auth + round-trip.
- Update existing hide-watched and OpenAPI / Linked Accounts tests for removal of `hideWatched` preference field and new resolve path.

## Implementation notes (guidance, not a plan)

- Prefer one JSON column over per-filter columns (filter set already grows with MDBList ratings).
- Do not store these prefs in admin `RequestFiltersSettings` (instance request policy ≠ personal browse defaults).
- Reuse existing FilterSlideover control building blocks where possible instead of a second parallel form implementation.
- Keep `discoverRegion` / `originalLanguage` / `streamingRegion` on General settings unless implementation finds a clean merge; v1 Discover defaults include `language` as a filter default independently if that matches FilterSlideover today.

## Decisions log

| Decision | Choice |
|----------|--------|
| Scope of filters | Full browse set (hide + quality + language + dates + genres) |
| Override model | Session override only (A) |
| Settings location | New User Settings → Discover (A) |
| Surfaces | All FilterSlideover surfaces (A) |
| Storage | JSON blob on `UserSettings` |
| Legacy toggle | Remove Linked Accounts hide-watched; migrate into JSON |
