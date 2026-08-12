# Post-Fork Feature Consistency Roadmap

Status: implemented and re-audited  
Audit date: 2026-08-12  
Audited range: Seerr baseline `bd491c7e7ecf7d249da532f8fe9b82456ed6e42e` through Foreseerr `develop` `82b6c832` (140 commits)

## Implementation status

The actionable P0–P2 findings in this roadmap were resolved or given an
explicit supported deployment constraint, then re-audited on 2026-08-12. The
completed work includes shared title-action state and cache
invalidation, per-user and per-title provider capabilities, explicit partial
write outcomes, movie/TV detail controls, direct Jellyfin Library episode
actions, shared rating badges, bounded Jellyfin batch reads, OpenAPI parity,
desktop protocol parity, and the documented Servarr deployment constraint.

The release gates now cover TypeScript, ESLint, Prettier, the complete server
test suite, and the production Next.js build. The sections below remain as the
decision record and acceptance criteria for regression review.

## Purpose

Foreseerr has gained several substantial features since its Seerr baseline, but
some capabilities are attached to the first UI surface that introduced them
instead of to the media domain as a whole. The clearest example is personal
watched state and ratings: the backend supports them and poster cards expose
them, while movie and TV detail pages do not.

This roadmap inventories the post-fork product work, records concrete
cross-surface and contract inconsistencies, and proposes an implementation
order. It is a consistency and architecture roadmap, not a new-feature wishlist.

## Executive summary

The first priority is the media-action system. It currently has four related
problems:

1. Movie and TV detail pages omit personal watched/rating actions entirely.
2. Episode watched writes can succeed on the server and still be rolled back by
   the client because the two sides expect different response shapes.
3. The UI assumes that actions require Trakt even though the backend also has a
   Jellyfin watched-state provider.
4. Provider capabilities and aggregation rules are implicit, which permits a
   Jellyfin rating no-op to be reported as a successful write and makes title
   and episode watched state disagree when providers differ.

The durable fix is a shared media-action domain layer: one capability contract,
one response schema, one state/invalidation hook, explicit aggregation policy,
and presentation variants for cards, details, seasons, and Library rows.

Other high-value work is to close Library watched-state gaps, keep filtered
Discover results fresh after mutations, align OpenAPI with runtime contracts,
and make Servarr operation state safe for multi-instance deployments.

## Post-fork feature inventory

| Area | Shipped capability | Principal implementation and surfaces | Consistency status |
| --- | --- | --- | --- |
| Trakt discovery | Per-user linking, watchlist, history, recommendations, liked/public lists, sorting, filtering, anime handling, and hide-watched | `server/api/trakt/`, `server/lib/trakt/`, `server/routes/discover.ts`, `src/components/Discover/DiscoverTrakt*`, `src/pages/discover/trakt/` | Broad surface coverage; mutation refresh and provider assumptions need work |
| Ratings enrichment | MDBList plus legacy rating enrichment; IMDb, Rotten Tomatoes, Metacritic, Trakt community, and TMDB badges | `server/lib/ratings/`, `server/api/mdblist/`, `src/components/Common/RatingBadges`, Movie/TV details, title cards | Card and detail renderers duplicate rules and disagree on zero scores |
| Personal media actions | Movie/TV status, batch status, watched/unwatched, rating, Trakt provider, and Jellyfin watched provider | `server/lib/mediaActions/`, `server/routes/mediaActions.ts`, `src/components/TitleCard/MediaActionControls.tsx` | Poster-only UI; provider and response contracts are inconsistent |
| TVDB episode requests | Individual episodes, ranges, ongoing requests, specials, quotas, request state, and Sonarr sync | `server/entity/EpisodeRequest.ts`, `server/lib/episodeRequests.ts`, `server/job/episodeRequestSync.ts`, `src/components/RequestModal/EpisodeSelector.tsx`, `src/components/TvDetails/Season/` | Feature is present in request and TV-detail flows; episode action response is broken |
| Release calendar | Normalized Radarr/Sonarr releases, personal/all scopes, filters, date changes, notifications, full-day view, and Arr management | `server/lib/releases/`, `server/routes/calendar.ts`, `src/components/Calendar/` | Core architecture is sound; identity and timezone regression coverage should grow |
| Jellyfin Library | Continue Watching, Recently Added, recent episodes, Ready to Watch, search/browse, series panel, next/resume/rewatch, and native/browser play | `server/lib/library.ts`, `server/routes/library.ts`, `src/components/Library/` | Episode watched state is read-only; identity resolution and cache updates are fragmented |
| Servarr management | Search, release selection, grabs, queue/activity, manual import, command polling, and Arr links | `server/routes/mediaServarr.ts`, `src/components/ManageSlideOver/ServarrManagement.tsx` | Available from details, Library, and Calendar; process-local operation tokens limit horizontal safety |
| Native desktop runtime | Native playback, browser fallback, challenge-bound single-use auth tickets, session binding, return recovery, chromeless mode, and Quit | `server/routes/desktop.ts`, `src/context/NativeRuntimeContext.tsx`, `protocol/protocol-v1.json` | Runtime is consistently v1, but OpenAPI still admits v2 |
| Discover/navigation polish | Discover navigation, mobile controls, filter defaults, custom sliders, and CEF drag behavior | `src/components/Discover/`, Sidebar, MobileMenu | Generally coherent; filtered lists do not always revalidate after media actions |
| Integration and fork consolidation | Foreseerr identity, consolidated integration settings, Direct/Better Trakt selection, and live health checks | `src/components/Settings/SettingsIntegrations.tsx`, `SettingsTrakt.tsx`, `SettingsBetterTrakt.tsx`, integration health backend | Reasonable direction; action settings still describe Trakt rather than operation capabilities |

## Original audit findings (addressed)

### P0 — Fix before expanding the feature set

#### 1. Episode watched actions use incompatible client and server contracts

`src/components/TvDetails/Season/index.tsx` posts an episode mutation and checks
`response.data.ok`. Since commit `f5832bf6`, `server/routes/mediaActions.ts`
returns `{ outcome, watched, providers }` instead. A successful server write
therefore looks false to the client, which restores the previous state and
shows an error. The OpenAPI response still describes the older
`{ provider, ok, watched }` shape.

Required work:

- Define one exported/schema-validated episode action response.
- Use it in the route, client, OpenAPI declaration, and tests.
- Treat HTTP 200 `success` and HTTP 207 `partial` as applied writes.
- Roll back only a real `failure`/502 or transport failure.

Acceptance criteria:

- Trakt-only, Jellyfin-only, and partial multi-provider writes remain visible
  after the response and do not show a failure toast.
- A total provider failure restores the prior state.
- An integration or component test exercises the actual client response shape,
  not only endpoint path presence.

#### 2. Personal title actions are confined to poster cards

`MediaActionControls` is mounted only by `src/components/TitleCard/index.tsx`.
Neither `src/components/MovieDetails/index.tsx` nor
`src/components/TvDetails/index.tsx` imports or renders it. External rating
badges on detail pages are not the user's personal rating.

Required work:

- Extract presentation-neutral state and mutations into `useMediaActions` (or
  an equivalent domain hook).
- Provide compact card controls and a labelled detail action bar from the same
  primitives.
- Mount the detail variant in both movie and TV action rows.
- Preserve keyboard, touch, loading, partial-success, and error behavior.

Acceptance criteria:

- A user can mark watched/unwatched and rate from movie details and TV details
  whenever the corresponding capability is available.
- A change made on a card appears on an already-open detail view, and vice
  versa, without a page reload.
- Card and detail variants have the same permission and capability rules.

#### 3. Provider interfaces claim unsupported rating writes succeed

`JellyfinMediaActionProvider.rate()` returns an empty status. The dispatcher
then labels the provider result `ok: true`; Jellyfin-only rating requests can
therefore report success without saving anything, and Trakt plus Jellyfin can
report full success when only Trakt performed the operation.

Required work:

- Add explicit provider capabilities per operation, at minimum
  `readWatched`, `writeWatched`, `readRating`, and `writeRating`.
- Exclude unsupported providers from an operation rather than invoking a no-op.
- Return a clear unsupported result when no enabled provider can perform an
  operation.
- Never convert missing mappings or provider read failures into an
  indistinguishable successful `unwatched` state.

Acceptance criteria:

- Rating controls are hidden or disabled with a clear reason when no
  rating-capable provider is available.
- No unsupported/no-op provider is reported as a successful write.
- Provider, dispatcher, route, and UI tests cover operation-specific support.

### P1 — Unify behavior across existing surfaces

#### 4. UI action eligibility is hard-coded to Trakt

Title cards, the title-card batch context, and TV season watched status all
require configured and linked Trakt state. The backend can perform watched
actions through a linked Jellyfin user, and public settings already emit
`mediaActionsJellyfinEnabled`, but the frontend does not consume it.

Do not fix this by adding another collection of Jellyfin booleans to each
component. Add an authenticated, per-user capability response and a shared
hook. Public server configuration cannot prove that the current user has a
working provider identity.

Acceptance criteria:

- A capability matrix passes for Trakt-only, Jellyfin-only, both, and neither.
- The matrix covers movie/TV cards, movie/TV details, and TV episodes.
- Watched and rating controls are gated independently.

#### 5. Multi-provider watched-state policy changes by endpoint

Title aggregation chooses the first successful provider, currently Trakt.
Episode status unions watched episode numbers from Trakt and Jellyfin. If the
providers drift, a show can appear unwatched at title level while its episodes
appear watched.

Required work:

- Choose and document one product policy. A sensible starting point is
  `watched = any enabled provider says watched`, while personal rating comes
  from the authoritative rating-capable provider.
- Preserve per-provider results for diagnostics and conflict presentation.
- Apply the same rule to title, season, and episode reads.

Acceptance criteria:

- Divergent Trakt/Jellyfin fixtures produce deterministic, documented results
  on every surface.
- Mutations expose partial synchronization rather than silently masking it.

#### 6. Watched-filtered Discover pages remain stale after some card actions

`MediaActionControls.onStatusChange` exists to refresh filtered parents, but
`ListView` passes `mutateParent` only for its `plexItems` path. Ordinary movie
and TV cards omit it, and the standard Discover movie/TV pages do not supply a
revalidator. Consequently, a title marked watched can remain in a
hide-watched result until a later refresh, while some Trakt-backed pages update
immediately.

Required work:

- Centralize invalidation for the canonical media-action status key, batch
  keys, detail keys, Library shelves, and active watched-filtered lists.
- Pass or register list revalidation consistently rather than by item shape.

Acceptance criteria:

- Marking an item watched removes it promptly from every active hide-watched
  list.
- Unfiltered lists update the action state without unnecessary full-page
  refetches.

#### 7. Library episode watched state is display-only

`src/components/Library/LibrarySeriesPanel.tsx` displays an episode's watched
state but offers only Play. TV detail seasons offer watched/unwatched controls.
This makes the owned-media experience less capable than the discovery detail
view even though Library already has the Jellyfin item identity.

Required work:

- Add watched/unwatched actions to Library episode rows using the shared action
  layer.
- Prefer direct Jellyfin item identity where available and reconcile the
  canonical TMDB/season/episode status cache.
- Revalidate Continue Watching, series play targets, and episode lists after a
  write.

Acceptance criteria:

- Library episode rows can toggle watched state with optimistic feedback and
  correct rollback.
- Continue Watching and next/resume targets update after the action.

#### 8. OpenAPI and TypeScript contracts have drifted from runtime behavior

Confirmed examples:

- Episode actions document the old response shape.
- Media-action provider enums in OpenAPI omit `jellyfin`.
- The backend public-settings response emits
  `mediaActionsJellyfinEnabled`, while its client TypeScript interface and
  default context omit it.
- Desktop runtime, server, and `protocol/protocol-v1.json` require protocol v1,
  while OpenAPI permits v1 or v2.

Required work:

- Make response schemas the source for route validation, exported TypeScript
  types, and OpenAPI where practical.
- Add exact response field/enum parity tests, not only path-existence tests.
- Make protocol version originate from the shared protocol artifact.

Acceptance criteria:

- CI fails when a route response, frontend type, and OpenAPI schema diverge.
- Desktop v1 is accepted everywhere and v2 rejected everywhere unless v2 is
  deliberately implemented end to end.

#### 9. Rating badges have separate card and detail implementations

Cards use `buildRatingBadges()` and `RatingBadges`; movie and TV detail pages
duplicate source visibility, formatting, icons, and links. Their zero-score
checks already differ: some use null checks and others use truthiness.

Required work:

- Make the shared badge builder/component support compact-card and detail
  presentation variants.
- Remove duplicated provider-selection logic from both detail pages.
- Add fixtures for zero, missing, malformed, and complete source data.

Acceptance criteria:

- The same rating payload yields the same visible sources and values on cards,
  movie details, and TV details.

### P2 — Scale and maintainability hardening

#### 10. Jellyfin batch status performs serial N+1 work

`JellyfinMediaActionProvider.getStatuses()` performs a media-row lookup and a
Jellyfin item call for every item in sequence. A title grid accepts batches of
up to 100 items, making this boundary expensive once Jellyfin-only visibility
is fixed.

Required work:

- Resolve mapped media rows in one database query.
- Use a Jellyfin bulk endpoint when available or bounded concurrency otherwise.
- Add a short per-user status cache with explicit mutation invalidation.

Acceptance criteria:

- A 100-item batch has no per-item database query and has measured, bounded
  provider concurrency.
- One provider failure remains isolated and does not erase other results.

#### 11. Servarr operation tokens are process-local

Interactive Servarr management keeps transient operation state in a local
`NodeCache`. Polling can lose its operation when requests reach another replica
or a process restarts.

Required work:

- Either persist short-lived operation records in the database/shared cache or
  explicitly declare single-instance/sticky-session operation as a deployment
  constraint.
- Bind records to user, media, operation type, and expiry.

Acceptance criteria:

- Start and poll can safely hit different application replicas, or deployment
  validation clearly prevents that unsupported topology.

#### 12. Large feature components obscure ownership boundaries

Several post-fork components combine data access, state machines, mutation
logic, and presentation: Calendar, Servarr management, TitleCard, TV details,
and the TV request modal are each roughly 850–1,500 lines. Size alone is not a
defect, but it contributed to consumer/contract drift and makes new surfaces
easy to overlook.

Refactor only along tested domain seams:

- Media actions: capability/status/mutation hook plus card/detail/episode views.
- Rating badges: shared model plus presentation variants.
- Servarr management: operation hook/state machine plus release/import views.
- Calendar: filter state, selected-occurrence panel, and calendar rendering.

Do not perform a broad cosmetic split without behavioral tests first.

## Delivery plan

### Phase 0 — Contract repair

1. Fix the episode action response mismatch and OpenAPI shape.
2. Add provider capabilities and stop reporting Jellyfin rating no-ops as
   success.
3. Add response-contract tests for media actions and desktop protocol versions.

Exit gate: no known successful write is presented as failure or vice versa.

### Phase 1 — Shared media actions

1. Implement the authenticated per-user capability contract.
2. Implement the shared media-action hook and canonical cache invalidation.
3. Define and test multi-provider aggregation/conflict policy.
4. Retain a compact poster presentation using the new layer.

Exit gate: Trakt/Jellyfin capability and divergent-state matrices pass at the
domain and card levels.

### Phase 2 — Surface parity

1. Add watched/rating actions to movie and TV detail pages.
2. Add episode watched actions to the Library series panel.
3. Refresh hide-watched Discover pages and Library playback shelves after
   mutations.
4. Consolidate external rating badge rendering.

Exit gate: poster, detail, TV episode, and Library workflows have explicit
cross-surface tests and remain synchronized without a full reload.

### Phase 3 — Operational hardening

1. Optimize Jellyfin batch status lookup and caching.
2. Make Servarr operation state multi-instance-safe or document/enforce the
   deployment constraint.
3. Add calendar timezone/all-day and identity-mapping regression tests.
4. Split large components only where the earlier phases establish stable
   tested seams.

Exit gate: a representative 100-card Jellyfin batch meets a defined latency and
call-count budget, and interactive management survives the supported deployment
topology.

## Cross-surface regression matrix

Every future user-facing media capability should be reviewed against this
matrix before release:

| Capability | Poster | Movie detail | TV detail | Season/episode | Library | Calendar | Mobile/touch | Native shell |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| External ratings | Yes | Yes | Yes | N/A | Through reused cards | No | Verify | Verify |
| Personal rating | Yes today | Missing | Missing | Not scoped | Missing | Not scoped | Verify | Verify |
| Title watched/unwatched | Yes, Trakt-gated | Missing | Missing | Episode control present but contract-broken | Read-only episode state | No | Verify | Verify |
| Request movie/season/episode | Yes | Yes | Yes | Yes | Owned media; normally unnecessary | Via details | Verify | Verify |
| Play owned media | Library cards | Yes | Yes | Library episodes | Yes | Via details | Verify | Yes |
| Servarr management | Library card path | Yes | Yes | Through parent manage view | Yes | Yes | Verify admin controls | Verify links |

For a new capability, `N/A` must be an explicit product decision; it should not
mean that the implementation happened to start elsewhere.

## Decisions to preserve

The audit found several unusual-looking choices that are reasonable and should
not be rewritten as cleanup:

- Release sync uses durable per-source fenced leases, atomic reconciliation,
  and notification handoff checks. This is appropriate for replicated jobs.
- Desktop auth tickets are short-lived, one-use, challenge-bound, and
  session-bound. Deleting older issued tickets during the session-binding
  migration was the safer compatibility choice.
- SQLite/PostgreSQL migration pairs, schema guards, frozen upstream/stable
  baselines, and upgrade matrices are strong and should remain release gates.
- Request-routing/eligibility rules were intentionally removed during
  integration consolidation. Current browse filtering is not evidence that the
  deleted routing feature was accidentally omitted; restoring it would be a
  separate product decision.
- The calendar's default personal scope and admin-only all-monitored scope are
  deliberate privacy/product policy, not missing functionality.

## Working rule for future fork features

Before calling a post-fork capability complete:

1. Define its domain capability and response schema independently of a screen.
2. Identify every applicable row in the cross-surface matrix.
3. Use shared mutation and invalidation behavior across those surfaces.
4. Test provider/configuration combinations and partial failures.
5. Assert runtime, OpenAPI, and TypeScript contract parity in CI.
6. Record every intentionally unsupported surface as a product decision.
