# Foreseerr Post-Fork Code Review

Date: 2026-08-20

## Executive summary

This review covers the current Foreseerr executable-code delta from the shared
Seerr base `bd491c7e7ecf7d249da532f8fe9b82456ed6e42e` through source snapshot
`29ac6770dd7503fe208ce1f7b6a9bb94aa50af90`.

The reviewed surface contains 426 changed executable paths:

- 260 server TypeScript files
- 162 client TypeScript/TSX files
- 4 Cypress TypeScript files

The audit found:

- 1 high-severity confirmed behavioral defect
- 11 medium-severity confirmed behavioral defects
- Several low-level syntax, component-contract, and test-consistency issues
- Significant fork-created structural debt, including duplicated provider
  infrastructure, oversized multi-responsibility modules, repeated UI flows,
  weakly discriminated types, and replicated test setup

No production source was modified during the review. A synthetic review commit
was created at `f75eda9b65475cd7c24fb4437007d6d895abe737` on
`review/post-fork-squash`. Its tree is identical to the source snapshot and its
sole parent is the Seerr base.

## Confirmed behavioral defects

### High

#### 1. Ongoing episode-request locking is process-local

[MediaRequest.ts](server/entity/MediaRequest.ts#L465) checks for an existing
ongoing request before insertion, while serialization is implemented by a
module-local map in [episodeRequests.ts](server/lib/episodeRequests.ts#L104).
Two requests handled by different replicas can both pass the read and create
duplicate ongoing requests. This can trigger duplicate Sonarr work and bypass
quota accounting.

**Recommended direction:** enforce the active ongoing-request invariant in the
database using a transaction, constraint, or database advisory lock. Translate
constraint conflicts into the existing duplicate-request response.

### Medium

#### 2. Unmonitored Arr releases never enter the calendar

[release sync](server/lib/releases/sync.ts#L147) calls the Radarr and Sonarr
calendar APIs with their default `includeUnmonitored=false`. The administrator
calendar API nevertheless exposes an `includeUnmonitored` filter in
[calendar.ts](server/routes/calendar.ts#L96). Because those releases are never
persisted, the filter cannot return them.

**Recommended direction:** synchronize unmonitored entries while retaining
their monitored state, then apply the normal permission/filter policy when
serving them.

#### 3. Editing an episode request bypasses current feature configuration

[request.ts](server/routes/request.ts#L537) can replace episode selections
without rechecking whether partial requests remain enabled, whether TVDB is
still the configured provider, or whether the target request is for TV. The
creation path performs these checks.

**Recommended direction:** reuse the creation-path feature, provider, and media
type guard before deleting or recreating child episode requests.

#### 4. Unmapped AniList writes are reported as successful

[anilist.ts](server/lib/mediaActions/anilist.ts#L121) returns an error-free empty
status when no mapping exists. [dispatcher.ts](server/lib/mediaActions/dispatcher.ts#L146)
therefore records `ok: true`, and the API can return a successful write even
though no provider mutation occurred.

**Recommended direction:** return an explicit `not_mapped` or skipped-provider
result and classify it as unavailable or failed rather than successful.

#### 5. AniList unwatch ignores `removeRating`

[anilist.ts](server/lib/mediaActions/anilist.ts#L160) deletes the entire AniList
list entry and its rating regardless of `removeRating`. The route passes this
option and the provider contract defines it, but the implementation does not
accept it.

**Recommended direction:** preserve score/list state for the default unwatch
operation and remove it only when explicitly requested.

#### 6. `mediaAdded` grouping conflates movies and TV series

[media.ts](server/routes/media.ts#L69) groups by `tmdbId` alone, although
[Media](server/entity/Media.ts#L29) identifies titles by both `tmdbId` and
`mediaType`. A movie and series with the same numeric TMDB ID can collapse into
one result, corrupting pagination and counts.

**Recommended direction:** group and join by both fields and add a cross-type ID
collision test.

#### 7. Instant-request capabilities are true without an Arr server

[settings/index.ts](server/lib/settings/index.ts#L885) evaluates
`undefined !== false` as enabled when no matching default Radarr or Sonarr
server exists. Clients can expose quick-request actions that cannot be
dispatched.

**Recommended direction:** require a matching default service before exposing
the capability.

#### 8. Startup can delete administrator-created discovery sliders

[DiscoverSlider.ts](server/entity/DiscoverSlider.ts#L37) deletes custom sliders
whose type later becomes built-in. The settings API permits custom sliders with
those type values, so a new built-in type can irreversibly remove administrator
configuration during startup.

**Recommended direction:** preserve custom rows or perform an explicit,
recoverable migration only for demonstrably obsolete duplicates.

#### 9. Direct Trakt changes leave public settings stale

[SettingsTrakt.tsx](src/components/Settings/SettingsTrakt.tsx#L219) saves direct
credentials and changes action settings at line 262 without revalidating
`/api/v1/settings/public`. The Better Trakt path does perform this invalidation.
Integration cards and media-action capability state can remain stale until a
later refresh.

**Recommended direction:** revalidate public settings and relevant media-action
caches after both successful paths.

#### 10. Failed media-status reads render enabled but unusable controls

[useMediaActions.ts](src/hooks/useMediaActions.ts#L96) discards the SWR error.
Missing data is treated as available and no longer pending, but the write path
at line 127 immediately refuses to act without data. The user sees an enabled
control followed by a failure toast without a write request.

**Recommended direction:** expose the request error and render an unavailable
or retry state, or keep controls disabled until usable status exists.

#### 11. Discover-default suppression leaks between users

[mergeFilterDefaults.ts](src/components/Discover/mergeFilterDefaults.ts#L4)
stores its "defaults cleared" marker per browser tab rather than per user. A
second account signing in within the same tab can inherit the first account's
clear action and lose its own saved defaults.

**Recommended direction:** key the marker by user ID or clear it whenever the
authenticated identity changes.

#### 12. AniList credential removal bypasses confirmation

[SettingsAnilist.tsx](src/components/Settings/SettingsAnilist.tsx#L279) directly
submits the destructive removal request despite defining dedicated confirmation
messages. The server then disconnects every linked AniList account in
[settings/index.ts](server/routes/settings/index.ts#L902).

**Recommended direction:** render and require the dedicated removal
confirmation before submitting `clearCredentials`.

## Structural smells and code replication

### High-priority structural debt

#### Discover routing monolith and repeated result mapping

[discover.ts](server/routes/discover.ts#L1) is 2,054 lines and grew by 1,423
lines in the fork. It owns 34 routes across TMDB, Plex, Trakt, AniList, and
MDBList, together with query parsing, pagination, mapping, and provider error
classification.

Eleven blocks beginning around [line 506](server/routes/discover.ts#L506)
repeat the same 20-21-line related-media lookup and mapping flow, totaling
roughly 220 duplicated lines. Each repeatedly calls `media.find()`, producing
avoidable O(results squared) lookup work.

**Recommended direction:** split provider-specific routers, extract shared typed
pagination/filter middleware, and map related media through a prebuilt
`(mediaType, tmdbId)` index.

#### Weak Servarr unions around destructive operations

[mediaServarr.ts](server/routes/mediaServarr.ts#L25) is a new 897-line route.
Its `type` field does not discriminate the Radarr/Sonarr client union, forcing
13 `as RadarrAPI`/`as SonarrAPI` assertions. Operation tokens use another broad
union recovered through unchecked casts around release grabs and imports.

**Recommended direction:** introduce discriminated `RadarrContext |
SonarrContext` and token records keyed by operation kind.

#### Duplicated optimistic-sync cache implementations

[syncCache.ts](server/lib/mediaActions/syncCache.ts#L26) and
[anilistSyncCache.ts](server/lib/mediaActions/anilistSyncCache.ts#L191)
independently implement per-user provider snapshots, optimistic patches,
invalidation, and refresh coordination. They duplicate roughly 60 lifecycle
lines but already disagree on patch acknowledgement: Trakt coalesces and drops
acknowledged patches, while AniList appends and replays patches until a cold
refresh.

**Recommended direction:** extract a generic keyed optimistic cache with
provider-specific snapshot adapters and one patch-acknowledgement contract.

#### Duplicated media-action controls

[MediaActionControls.tsx](src/components/TitleCard/MediaActionControls.tsx#L51)
and [MediaActionDetailBar.tsx](src/components/MediaActions/MediaActionDetailBar.tsx#L40)
duplicate roughly 260 lines of rating conversion, star rendering, popover
positioning, document listeners, writes, and toast handling.

They have already diverged: the detail version provides dialog semantics and
restores focus on Escape, while the title-card version does neither.

**Recommended direction:** extract shared media-action and rating-popover
primitives, leaving layout and event-propagation behavior in small wrappers.

#### Oversized manual-import workflow

[ServarrManagement.tsx](src/components/ManageSlideOver/ServarrManagement.tsx#L134)
is a new 889-line component with 23 state values. It combines context loading,
target selection, release discovery/grab, import-source discovery, rematching,
submission, polling, and rendering. Independent operations share `loading` and
`error`, so one flow can disable or overwrite another flow's state.

**Recommended direction:** split operation-specific data hooks and separate
`ReleaseSearch` and `ManualImport` components with scoped status and
cancellation.

#### Oversized request policy method

[MediaRequest.request()](server/entity/MediaRequest.ts#L58) is roughly 685 lines
and combines authorization, quotas, TMDB retrieval, anime detection, episode
validation, media creation, duplicate detection, override rules, entity
construction, and persistence. The fork substantially amplified inherited
complexity.

**Recommended direction:** build typed movie, TV, and episode `RequestPlan`
objects before entering a small persistence transaction.

### Backend duplication and inconsistent abstractions

- [baseScanner.processShow()](server/lib/scanners/baseScanner.ts#L279) is 369
  lines and contains four versions of standard/4K season transition and rollup
  logic. Extract a pure per-quality transition and title rollup.
- [mediaActions.ts](server/routes/mediaActions.ts#L145) repeats provider fan-out,
  aggregation, and error conversion already owned by
  [dispatcher.ts](server/lib/mediaActions/dispatcher.ts#L110). Episode and
  direct Jellyfin routes also serialize reduced, incompatible response shapes.
- Three provider error handlers beginning at
  [discover.ts line 202](server/routes/discover.ts#L202) duplicate about 82
  lines. Trakt, MDBList, and AniList also implement separate Retry-After parsing
  and accept different header representations.
- Linked AniList identity resolution is triplicated in
  [discover.ts](server/routes/discover.ts#L286),
  [anilist.ts](server/lib/mediaActions/anilist.ts#L235), and
  [anilistEpisodes.ts](server/lib/mediaActions/anilistEpisodes.ts#L34).
- [buildWatchNowResponse()](server/lib/library.ts#L549) is a 210-line
  orchestration function that repeats shelf-specific try/log/push behavior and
  mixes thrown errors with sentinel error codes.
- [library routes](server/routes/library.ts#L45) duplicate roughly 75 lines of
  parsing, pagination, response construction, and error conversion between
  available and search endpoints.
- [calendar.ts](server/routes/calendar.ts#L77) has a 229-line handler combining
  query parsing, authorization, joins, URL validation, history selection, date
  preference, and DTO construction.
- Gotify, Ntfy, Pushbullet, Pushover, Slack, and Telegram agents repeat the same
  notification-status mapping, beginning with
  [gotify.ts](server/lib/notifications/agents/gotify.ts#L68).
- Notification bitmask behavior is duplicated verbatim between
  [server notifications](server/lib/notifications/index.ts#L24) and
  [NotificationTypeSelector](src/components/NotificationTypeSelector/index.tsx#L75).
- Route-test `createApp()` and `loginAsAdmin()` infrastructure is copied across
  five changed test suites, including
  [mdblist-settings.test.ts](server/routes/settings/mdblist-settings.test.ts#L23)
  and [trakt-settings.test.ts](server/routes/settings/trakt-settings.test.ts#L34).

### Frontend duplication and complexity

- [Calendar](src/components/Calendar/index.tsx#L189) is a new 993-line
  coordinator combining date math, filtering, local-storage state, responsive
  month/agenda views, details, and management. Extract view-state, filter,
  rendering, and details modules.
- Trakt History, Recommendations, and Watchlist repeat account checks, SWR
  loading, unlinked-account UI, filtering, headers, and list rendering:
  [History](src/components/Discover/DiscoverTraktHistory/index.tsx#L25),
  [Recommendations](src/components/Discover/DiscoverTraktRecommendations/index.tsx#L29),
  and [Watchlist](src/components/Discover/DiscoverTraktWatchlist/index.tsx#L25).
- [TraktListSlider](src/components/Discover/TraktListSlider/index.tsx#L30),
  [MdblistListSlider](src/components/Discover/MdblistListSlider/index.tsx#L31),
  and [AnilistSlider](src/components/Discover/AnilistSlider/index.tsx#L30)
  repeat approximately 60-75 lines per provider.
- Keyword and company option loaders are duplicated between
  [CreateSlider](src/components/Discover/CreateSlider/index.tsx#L291) and
  [Selector](src/components/Selector/index.tsx#L100). Both pre-encode values
  passed through Axios `params`, risking double encoding.
- [UserDiscoverSettings](src/components/UserProfile/UserSettings/UserDiscoverSettings/index.tsx#L108)
  stores one genre selection in three synchronized states and independently
  reimplements the filter contract from
  [FilterSlideover](src/components/Discover/FilterSlideover/index.tsx#L1).
- Movie and TV details contain near-identical watchlist/blocklist handlers in
  [MovieDetails](src/components/MovieDetails/index.tsx#L343) and
  [TvDetails](src/components/TvDetails/index.tsx#L379), with small behavioral
  differences already appearing.
- Radarr and Sonarr settings modals duplicate approximately 49 lines of
  connection-test behavior:
  [RadarrModal](src/components/Settings/RadarrModal/index.tsx#L155) and
  [SonarrModal](src/components/Settings/SonarrModal/index.tsx#L167).
- [StatusBadge](src/components/StatusBadge/index.tsx#L211) repeats roughly 96
  lines of season/episode progress JSX across four status branches.
- [Selector](src/components/Selector/index.tsx#L139) uses six `as any` escapes
  because its single/multi-selection contract is not represented with generics
  or discriminated props.
- [SettingsMdblist](src/components/Settings/SettingsMdblist.tsx#L118) treats an
  SWR read failure as an unconfigured integration and renders editable defaults,
  unlike the adjacent Trakt and AniList forms. A failed read can therefore lead
  to overwriting existing settings.
- [LibraryInspector](src/components/Library/LibraryInspector.tsx#L191) declares
  modal dialog semantics but lacks focus trapping, allowing keyboard focus to
  escape behind the modal.

### Tests and stale code

- [tvdb.cy.ts](cypress/e2e/providers/tvdb.cy.ts#L113) changes global provider
  configuration without restoring it, making tests order-dependent.
- The media-action capabilities fixture is duplicated between
  [tvdb.cy.ts](cypress/e2e/providers/tvdb.cy.ts#L24) and
  [library.cy.ts](cypress/e2e/library.cy.ts#L24).
- The same TVDB episode catalog and mutation are copied twice inside
  [tvdb.cy.ts](cypress/e2e/providers/tvdb.cy.ts#L198).
- [ButtonWithDropdown](src/components/Common/ButtonWithDropdown/index.tsx#L15)
  exposes `dropdownAction`, but no caller uses it.
- [RequestButton](src/components/RequestButton/index.tsx#L37) says
  single-episode requests are reserved for the future even though the file now
  implements them.
- [anilistSyncCache.ts](server/lib/mediaActions/anilistSyncCache.ts#L248)
  accepts an unused `userId`, misleadingly suggesting user-specific fetch
  behavior.
- [NotificationsWebhook](src/components/Settings/Notifications/NotificationsWebhook/index.tsx#L435)
  has an unused `header` callback parameter.
- [MediaRequest.ts](server/entity/MediaRequest.ts#L376) retains a vague
  "hacky way"/"TODO: make this better" comment beside rule-prioritization logic.
- Settings save-button and notification test/save boilerplate repeat across
  multiple forms. Extraction is lower priority because provider-specific
  behavior remains substantial.

## Syntax and consistency findings

- [Dropdown](src/components/Common/Dropdown/index.tsx#L33) drops supplied HTML
  props in its button branch, including `className`, ARIA attributes, and test
  IDs.
- [library.cy.ts](cypress/e2e/library.cy.ts#L181) claims to test restoration
  after closing Manage but never opens or closes Manage.
- ESLint reports an omitted effect dependency set in
  [TvRequestModal.tsx](src/components/RequestModal/TvRequestModal.tsx#L420).
  No independent functional regression was confirmed, but it violates the
  configured hook rule.
- Explicit `any` warnings remain in
  [0002_migrate_apitokens.ts](server/lib/settings/migrations/0002_migrate_apitokens.ts#L8)
  and [discover.ts](server/routes/discover.ts#L1208).
- Configured `no-console` warnings remain in
  [NativeRuntimeContext.tsx](src/context/NativeRuntimeContext.tsx#L224) and
  [useDiscover.ts](src/hooks/useDiscover.ts#L178).

## Validation

| Check | Result |
| --- | --- |
| Executable diff whitespace check | Passed |
| Prettier across all 426 scoped files | Passed |
| ESLint across all 426 scoped files | 0 errors, 5 warnings |
| Server TypeScript check | Passed |
| Client TypeScript check | Passed |
| Production client/server build | Passed |
| Server tests | 616 total, 614 passed, 2 skipped, 0 failed |
| SQLite migrations and schema invariants | Passed |
| PostgreSQL migration execution | Not run; DB credentials unavailable |
| PostgreSQL upgrade tests | 2 skipped; DB credentials unavailable |
| Cypress | Not run; Cypress binary unavailable and no installation was performed |

The mechanical structural pass inventoried every changed function-like node,
triaged 564 large or branch-heavy candidates, found 13 exact normalized
function-body clone groups, and manually traced additional near-clones.

Intentional SQLite/PostgreSQL migration parity was excluded from duplication
findings. Framework-required unused request parameters were also excluded.

## Rejected false positives

- The Calendar SWR mutation was initially suspected of binding to a shadowed
  local `mutate`. The calls are in a separate module-scope component and
  correctly resolve to the imported global SWR mutator.
- Concurrent AniList mapping initialization was initially suspected of returning
  before mapping was available. Action callers await mapping synchronization;
  no stale-mapping defect was confirmed.
- `MediaRequest.sortChildren()` appears to have no direct call site but is a
  TypeORM `@AfterLoad` lifecycle hook and is not dead code.
- Paired SQLite/PostgreSQL migration bodies are intentional dialect-specific
  duplication.
- The changed integration logic in `server/index.ts` was reviewed and found
  appropriate for the application entrypoint.

## Recommended remediation order

1. Fix the confirmed behavioral defects, starting with database-backed ongoing
   request serialization and destructive/untruthful provider operations.
2. Split `discover.ts` and introduce the shared indexed result mapper before
   adding more discovery providers or filters.
3. Introduce discriminated Servarr contexts/tokens before further expanding
   manual import and release management.
4. Consolidate provider sync caches, media-action controls, provider error
   handling, and linked-AniList context resolution.
5. Decompose the Calendar and Servarr management components and normalize their
   operation-specific state.
6. Extract repeated Discover pages/sliders, option loaders, notification
   semantics, and route-test fixtures.
7. Remove stale API surface/comments and make the lint warning count zero.
