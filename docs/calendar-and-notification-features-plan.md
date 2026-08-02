# Calendar and Notification Features Implementation Plan

Status: proposed  
Planning date: 2026-08-01  
Target product: Foreseerr / SeerrSuggestArr

## 1. Objective

Add a personal release-planning experience that combines Sonarr and Radarr dates,
highlights the user's requested titles, detects new seasons and date changes, and
sends useful summaries without generating one notification per event.

The finished feature set should provide:

- A unified Sonarr/Radarr release calendar.
- A personal view of upcoming requested movies, seasons, and episodes.
- New-season notifications for relevant users.
- A weekly personal recommendation digest.
- An actionable "your request is available" notification with a direct
  Jellyfin/Emby link when one exists.
- Daily or weekly digests for release-related events.
- Notifications when tracked release dates move or releases are delayed.

This plan extends the existing scheduled-job, Servarr API, request, Trakt,
notification-agent, and Jellyfin deep-link infrastructure. It should not create
a second notification delivery stack.

## 2. Product decisions and scope

### 2.1 Delivery policy

Use two notification classes:

| Class | Default delivery | Events |
| --- | --- | --- |
| Transactional | Immediate | Request available |
| Informational | Digest | Upcoming releases, new seasons, release-date changes, recommendations |

"Request available" is immediate by default because the user can act on it
right away. A user may change it to daily digest or disable it. Release-related
events default to a daily digest; recommendations default to a weekly digest.

Do not send empty digests. Coalesce several changes to the same title into one
digest item and show the latest state. For example, a title moving twice before
the next digest produces one item with the first known date and final date.

### 2.2 Calendar visibility

- Every authenticated user can open the unified calendar.
- The default filter is **Relevant to me**: the user's own requested titles and
  new content attached to those titles.
- An **All monitored releases** filter shows all entries returned by configured
  Sonarr/Radarr instances. This is household catalog information, not request
  ownership information.
- Request ownership and requester names must not be exposed unless the viewer
  already has request-management permission.
- Administrators can filter by Servarr instance, monitored status, and 4K/non-4K.

### 2.3 Definition of "upcoming requested"

An occurrence is personal when it maps to a `Media` record with an active
`MediaRequest` owned by the current user. Include pending, approved, and
processing requests; exclude declined and failed requests unless explicitly
selected in a filter.

- Movie: use the selected Radarr availability date.
- Full-season TV request: include the season premiere and optionally individual
  episodes.
- Partial episode request: include only explicitly requested episodes.
- "From episode onward" request: include all materialized requested episodes.
- Already available entries may remain visible with an Available badge until
  their release day has passed.

### 2.4 Definition of "new season"

Treat the first non-special episode in a season (`seasonNumber > 0`) as the
season premiere. A season becomes notification-worthy when:

1. Sonarr reports the premiere for a season not previously seen in the local
   release snapshot; and
2. the season belongs to a series relevant to the user; and
3. its premiere is in the future or within a configurable recent grace period
   (default: seven days).

For the first release, relevance means that the user previously requested any
part of the series. Later, the same resolver can add Jellyfin/Plex watch history,
Trakt history/watchlist, and explicit series follows without changing delivery
code.

Do not automatically request the season. The notification links to the
Foreseerr series page and presents a Request action.

### 2.5 Movie date selection

Radarr may provide several dates. Store all known dates but calculate one
primary display date according to user preference:

1. Digital release (default)
2. Physical release
3. Theatrical release

If the preferred date is absent, fall back in the order digital, physical,
theatrical. Label the chosen date type in the UI and digest; never present a
theatrical date as if it were a home-media availability date.

### 2.6 Recommendation digest

The first implementation uses existing authenticated Trakt recommendations.
Only send a personal recommendation section when a user has a working Trakt
connection and enough candidates. Do not silently replace it with generic
trending titles and call that personal.

Select a small, useful set (default: five) after removing titles that are:

- Already watched when Trakt history is available.
- Already available locally, unless a future "Watch now" section is enabled.
- Already requested.
- Blocklisted.
- Dismissed by the user once recommendation feedback exists.

Reuse the existing Trakt cache and recommendation mapping. Preserve source
attribution and add a concise reason when the current recommendation pipeline
can supply one. Recommendation-provider expansion is outside this feature's
first release and is covered by `docs/product-roadmap-and-recommendation-research.md`.

## 3. Existing extension points

The implementation should build on these current components:

- `server/api/servarr/sonarr.ts` and `server/api/servarr/radarr.ts` for upstream
  calls.
- `server/job/schedule.ts` and `server/lib/settings/index.ts` for recurring work.
- `server/entity/Media.ts` for Servarr identity, Jellyfin media IDs, and generated
  `mediaUrl`/`mediaUrl4k` deep links.
- `server/entity/MediaRequest.ts`, `SeasonRequest`, and `EpisodeRequest` for
  personal relevance.
- `server/subscriber/MediaRequestSubscriber.ts` for the existing
  `MEDIA_AVAILABLE` trigger.
- `server/lib/notifications/index.ts` and existing agents for delivery.
- `server/entity/UserSettings.ts` and user settings routes for per-user choices.
- `server/lib/trakt/recommendations.ts` for weekly recommendations.
- `src/components/NotificationTypeSelector` for agent-level event opt-ins.

The existing notification payload is oriented around one media item. Digests
need a typed batch payload, but existing transactional notification behavior
must remain backward compatible.

## 4. Proposed architecture

```text
Sonarr / Radarr
       |
       v
Release sync job ----> normalized release occurrences ----> calendar API/UI
       |                          |
       |                          v
       +------------------> change detector
                                  |
Request availability ------------+----> notification outbox
Trakt recommendations ------------+             |
                                                v
                                  digest compiler / scheduler
                                                |
                                                v
                              existing notification agents
                  (email, web push, Discord, Telegram, etc.)
```

Separate discovery from delivery:

- Sync jobs discover facts and persist normalized state.
- Producers enqueue deduplicated, user-targeted notification events.
- A compiler groups due events into a digest.
- Existing notification agents render and send the compiled payload.
- Delivery attempts and final state are persisted for safe retries.

This separation is required for digesting, idempotency, date-change history,
manual job runs, and restart safety.

## 5. Data model

Create matching SQLite and PostgreSQL migrations for every schema change.

### 5.1 `ReleaseOccurrence`

A normalized calendar occurrence and date-change snapshot.

| Field | Type / notes |
| --- | --- |
| `id` | Primary key |
| `source` | `sonarr` or `radarr` |
| `sourceServerId` | Foreseerr Servarr settings ID |
| `sourceItemId` | Radarr movie ID or Sonarr episode ID |
| `sourceSeriesId` | Sonarr series ID; null for movies |
| `mediaType` | `movie` or `tv` |
| `tmdbId` | Nullable until mapping succeeds |
| `tvdbId` | Nullable; episode or series mapping as appropriate |
| `mediaId` | Nullable FK to `Media`, `SET NULL` on delete |
| `title` | Movie or series title snapshot |
| `subtitle` | Episode title, nullable |
| `seasonNumber` | Nullable |
| `episodeNumber` | Nullable |
| `dateType` | `air`, `digital`, `physical`, `theatrical` |
| `startsAt` | UTC timestamp |
| `allDay` | Boolean; true when upstream has only a date |
| `monitored` | Upstream monitored state |
| `hasFile` | Upstream availability hint |
| `is4k` | Derived from configured Servarr instance |
| `sourceUrl` | Generated Sonarr/Radarr link, nullable |
| `rawDates` | JSON containing the provider dates needed for re-selection |
| `firstSeenAt` | Timestamp |
| `lastSeenAt` | Timestamp |
| `missingSince` | Nullable timestamp for upstream deletions |
| `createdAt`, `updatedAt` | Timestamps |

Indexes and constraints:

- Unique: `(source, sourceServerId, sourceItemId, dateType)`.
- Range query: `(startsAt, mediaType)`.
- Personal joins: `mediaId`.
- Cleanup: `missingSince`.
- Series detection: `(sourceServerId, sourceSeriesId, seasonNumber,
  episodeNumber)`.

Keep one record per upstream date type for movies so switching a user's date
preference does not require a re-sync. The API chooses the primary occurrence
and may expose secondary dates in details.

### 5.2 `ReleaseDateChange`

Persist meaningful movements separately from the current occurrence.

| Field | Type / notes |
| --- | --- |
| `id` | Primary key |
| `occurrenceId` | FK, cascade on occurrence deletion |
| `oldStartsAt` | Nullable for newly announced dates |
| `newStartsAt` | Nullable when a date is withdrawn |
| `changeKind` | `announced`, `moved_earlier`, `delayed`, `withdrawn` |
| `detectedAt` | Timestamp |
| `notifiable` | False for initial backfill or insignificant churn |
| `metadata` | JSON for source/date labels and debugging |

Use a configurable significance threshold (default: 12 hours for timed TV
events, one calendar day for all-day movie dates). A timezone-only
normalization change must not appear as a release delay.

### 5.3 `NotificationEvent`

Durable per-user outbox items.

| Field | Type / notes |
| --- | --- |
| `id` | Primary key |
| `userId` | Recipient FK, cascade on user deletion |
| `eventType` | Stable string enum |
| `deliveryClass` | `transactional`, `daily_digest`, `weekly_digest` |
| `dedupeKey` | Stable producer key |
| `occurredAt` | When the underlying event occurred |
| `notBefore` | Earliest eligible delivery time |
| `payload` | Versioned JSON payload containing IDs, not secrets |
| `status` | `pending`, `reserved`, `sent`, `failed`, `cancelled` |
| `attemptCount` | Retry counter |
| `reservedAt` | Nullable lease timestamp |
| `sentAt` | Nullable |
| `lastError` | Truncated/sanitized text, nullable |
| `createdAt`, `updatedAt` | Timestamps |

Unique: `(userId, eventType, dedupeKey)`. Updating an existing pending event is
allowed when coalescing repeated date changes; never update a sent event.

Recommended event types:

- `release.upcoming`
- `release.new_season`
- `release.date_changed`
- `request.available`
- `recommendation.weekly`

### 5.4 `NotificationDelivery`

Track one compiled send per recipient, cadence window, and agent.

| Field | Type / notes |
| --- | --- |
| `id` | Primary key |
| `userId` | Recipient |
| `agent` | Existing `NotificationAgentKey` |
| `digestType` | `immediate`, `daily`, `weekly` |
| `windowStart`, `windowEnd` | UTC bounds |
| `eventIds` | JSON array or join table; prefer join table if query needs grow |
| `status` | `pending`, `sending`, `sent`, `partial`, `failed` |
| `attemptCount`, `lastError` | Retry state |
| `sentAt`, `createdAt`, `updatedAt` | Timestamps |

Use a unique idempotency key derived from user, agent, cadence, and window. A
server restart must not send the same digest twice.

### 5.5 User preference additions

Add columns to `UserSettings` rather than packing cadence into the current
notification bitmask:

- `timezone`: IANA timezone, default inherited from system setting and finally
  `UTC`.
- `calendarMovieDateType`: `digital`, `physical`, or `theatrical`.
- `dailyDigestEnabled`: default true.
- `dailyDigestTime`: local `HH:mm`, default `08:00`.
- `weeklyDigestEnabled`: default false until a recommendation source is linked.
- `weeklyDigestDay`: `0..6`, default Sunday.
- `weeklyDigestTime`: local `HH:mm`, default `09:00`.
- `availabilityDelivery`: `immediate`, `daily`, or `off`.
- `newSeasonNotifications`: default true.
- `releaseChangeNotifications`: default true.
- `upcomingReleaseNotifications`: default true.
- `recommendationDigestEnabled`: default false.

Continue using the existing per-agent notification type bitmask to decide which
agents may deliver each category. Cadence answers **when**; the bitmask answers
**where** and **whether for that agent**.

### 5.6 Notification enum compatibility

The current notification enum is mirrored in server and client code and stored
as bitmasks. Add new power-of-two values without renumbering existing values:

- `RELEASE_DIGEST = 8192`
- `NEW_SEASON = 16384`
- `RELEASE_DATE_CHANGED = 32768`
- `RECOMMENDATION_DIGEST = 65536`

Keep `MEDIA_AVAILABLE = 8`; extend its delivery path instead of introducing a
duplicate availability type. Update `ALL_NOTIFICATIONS`, admin permission
mapping, API types, selector labels, tests, and all notification agents.

## 6. Backend workstreams

### 6.1 Extend the Servarr clients

In `server/api/servarr/sonarr.ts`:

- Add typed `getCalendar(start, end, includeUnmonitored)` using Sonarr v3's
  calendar endpoint.
- Request a bounded window and page/split it if needed.
- Model series metadata embedded in calendar responses.
- Preserve `airDate` and `airDateUtc`; prefer UTC when supplied.
- Add contract tests for missing dates, specials, monitored state, and series
  mapping.

In `server/api/servarr/radarr.ts`:

- Add typed `getCalendar(start, end, includeUnmonitored)`.
- Extend `RadarrMovie`/calendar result types with `inCinemas`, `digitalRelease`,
  `physicalRelease`, year, images, and availability data actually returned by
  supported Radarr versions.
- Treat dates without a time as all-day events.
- Add contract tests for each date type and missing/invalid values.

Compatibility requirements:

- Fail one Servarr instance independently; do not discard results from healthy
  instances.
- Log server ID/name, endpoint, and safe error details without API keys.
- Apply the repository's configured API timeout.
- Deduplicate entries from standard and 4K instances only in presentation;
  retain both source records so filters and source links remain correct.

### 6.2 Release sync service and scheduled job

Add `server/lib/releases/sync.ts` and a small job wrapper such as
`server/job/releaseCalendarSync.ts`.

Suggested default sync behavior:

- Run every six hours.
- Fetch from 30 days in the past through 365 days in the future.
- On first run, backfill state without creating change notifications.
- Upsert occurrences in a transaction per Servarr instance.
- Map Radarr `tmdbId` and Sonarr series `tvdbId` to existing `Media` rows.
- Mark unseen rows with `missingSince`; delete only after a seven-day grace
  period so a temporary upstream failure does not look like withdrawal.
- Record a `ReleaseDateChange` only when the normalized date materially changes.
- Expose progress/running/cancellation state like existing scanners.

Add a `release-calendar-sync` `JobId`, default schedule, job UI metadata, manual
run support, and status reporting wherever scheduled jobs are currently listed.

Concurrency and safety:

- Use an in-process running guard consistent with existing jobs.
- Make every upsert and notification producer idempotent.
- Limit concurrent calls across multiple Servarr instances.
- Do not enqueue user events until the instance transaction succeeds.
- Emit metrics/log fields for fetched, inserted, changed, missing, unmapped, and
  errored counts.

### 6.3 Relevance resolver

Add `server/lib/releases/relevance.ts` as the single place that answers which
users are related to an occurrence.

Initial inputs:

- `MediaRequest.requestedBy`.
- Requested seasons and episodes.
- Request status.
- 4K status and source instance.

Return a reason (`requested_movie`, `requested_series`, `requested_season`, or
`requested_episode`) with the user ID. Keep the interface extensible for
watch-history and explicit-follow reasons.

Rules:

- A movie occurrence relates to active requesters for the same quality class.
- A requested season relates only to episodes in that season.
- A partial episode request relates only to its materialized episode rows.
- A new, unrequested season may relate to a prior requester of that series for
  the new-season event, but not be labeled "requested" in the calendar.
- Do not infer household-wide interest from a single user's request.

### 6.4 Change and new-season producers

After a successful sync:

- For each notifiable `ReleaseDateChange`, resolve recipients and upsert a
  `release.date_changed` event.
- Classify a move later as **Delayed**, a move earlier as **Moved earlier**, a
  newly supplied date as **Date announced**, and a removed date as **Date
  withdrawn**.
- Suppress changes to secondary Radarr dates unless they are the user's selected
  movie date or the previous selected date disappeared.
- Detect new Sonarr seasons from unseen season-premiere occurrences.
- Create `release.new_season` only once per user, series, and season.
- Include stable identifiers and original/latest dates in payloads; resolve
  mutable title/poster/link data again while compiling the digest.

Do not emit a separate "upcoming" outbox event for every calendar row during
sync. The daily compiler should query relevant occurrences in its upcoming
window and generate one release section. This prevents large, long-lived queues.

### 6.5 Notification outbox and digest compiler

Add services under `server/lib/notifications/digest/`:

- `outbox.ts`: enqueue/update/cancel events.
- `preferences.ts`: calculate the next local send time safely across DST.
- `compiler.ts`: reserve eligible events and build sections.
- `delivery.ts`: call agents, record results, release or retry leases.
- `cleanup.ts`: remove old sent/cancelled events and deliveries according to
  retention policy.

Add scheduled jobs:

- `notification-dispatch`: every minute, sends immediate events and due digests.
- `notification-cleanup`: daily, keeps delivery metadata for 90 days by default.
- The weekly recommendation producer may run hourly and enqueue only users whose
  local weekly window is due, or be folded into dispatch.

Digest section order:

1. Available now
2. New seasons
3. Release changes and delays
4. Coming in the next seven days
5. Recommendations for you (weekly only)

Limits:

- Default maximum 10 entries per section.
- Collapse overflow into "View N more" linking to a filtered calendar/feed.
- Sort actionable availability first, then by date.
- Combine duplicate standard/4K occurrences into one visual item with badges.
- Never include another user's name or email in a personal digest.

Retry behavior:

- Lease reserved rows so two dispatcher ticks cannot send them concurrently.
- Recover leases older than a short timeout.
- Use exponential backoff with a maximum attempt count.
- Treat success/failure independently per notification agent.
- Mark events sent only after all intended agents have a terminal result;
  represent partial delivery explicitly.

### 6.6 Recommendation producer

Add `server/lib/notifications/digest/recommendations.ts`:

- Select users with recommendation digest enabled and valid Trakt credentials.
- Call the existing recommendation service once per due user, respecting cache
  and rate limits.
- Fetch more candidates than needed, then filter and rank down to the configured
  count.
- Enqueue one `recommendation.weekly` event whose payload contains stable TMDB
  IDs, media types, rank, and source—not full provider responses.
- If Trakt is unavailable, retry within the weekly window; do not send a digest
  titled personal recommendations with no personal items.
- If one section fails but other weekly sections exist, send the useful sections
  and record the recommendation failure for retry/observability.

Credential refresh and invalid-account behavior must reuse existing Trakt
helpers. A revoked connection should disable/skips recommendations and surface a
reconnect state in settings rather than repeatedly failing.

### 6.7 Request-available delivery and Jellyfin link

Keep availability detection in `MediaRequestSubscriber`, but replace direct
fan-out with a notification service that observes the user's cadence:

1. Reload `Media` after the library scanner has written Jellyfin IDs.
2. Use `Media.mediaUrl` or `mediaUrl4k`, which already generates the direct
   Jellyfin/Emby web URL from the server ID and external hostname.
3. Store only the media/request IDs in the outbox payload.
4. At delivery time, reload the media and calculate the link again so hostname
   changes do not leave stale links in queued notifications.
5. Prefer **Watch in Jellyfin** when a direct URL is present; fall back to
   **View in Foreseerr** when it is not.

For immediate users, dispatch as soon as possible through the outbox. For daily
users, include the item in **Available now**. Maintain the existing one-time
availability semantics and add a dedupe key containing request ID, quality, and
availability transition version.

Update every capable agent:

- Email: clear primary CTA, poster, release/request context, accessible plain
  text fallback.
- Web push, Pushover, Pushbullet, Gotify, and ntfy: set the click/action URL to
  Jellyfin when available.
- Discord, Slack, Telegram: include a safe direct link or button supported by
  the platform.
- Webhook: add versioned `watchUrl`, `foreseerrUrl`, `sections`, and `digest`
  fields without removing existing fields.

Validate generated URLs as HTTP(S), use configured external hostnames, and never
expose the Jellyfin API key or access token.

## 7. API design

### 7.1 Calendar endpoints

Add `server/routes/calendar.ts`, registered as authenticated `/calendar`:

`GET /api/v1/calendar`

Query parameters:

- `start` and `end`: required ISO dates/timestamps with a maximum range (for
  example 366 days).
- `scope`: `mine` (default) or `all`.
- `mediaType`: optional `movie` or `tv`.
- `source`: optional `sonarr` or `radarr`.
- `serverId`: optional; admin only.
- `is4k`: optional boolean.
- `includeEpisodes`: default true for a month/week range and false for a compact
  year view.
- `includeUnmonitored`: default false; admin only.

Response:

- Normalized items grouped or sortable by `startsAt`.
- `id`, type, title/subtitle, season/episode, date type, all-day flag, badges,
  poster path, Foreseerr detail URL, and permitted Servarr URL.
- `requestedByCurrentUser`, `requestStatus`, and `available`.
- Never return raw provider payloads or credentials.
- Include a `partialSources` warning when one or more instances failed the last
  sync or are stale.

`GET /api/v1/calendar/summary`

- Small payload for dashboard widgets: next seven days, counts, and next
  personal release.

`GET /api/v1/calendar/feed.ics`

- Optional follow-up after the core calendar is stable.
- Use a revocable per-user token, not session cookies in the URL.
- Scope it to the user's relevant events by default.
- Escape ICS values, publish stable UIDs, UTC timestamps, and no private
  requester data.

### 7.2 Notification preference endpoints

Extend the existing user settings endpoints or add
`/user/:id/settings/digests` protected by `isOwnProfileOrAdmin`.

- `GET`: return timezone, cadence, category toggles, available sources, and a
  computed `nextDailyDelivery`/`nextWeeklyDelivery`.
- `POST`: validate IANA timezone, local time, weekday, enums, and booleans.
- Do not allow an admin editing another user to expose Trakt tokens.
- Add `POST /test` for a preview/test digest that does not consume real outbox
  events.

### 7.3 Admin operational endpoints

Follow the existing scheduled-job controls for:

- Manual release sync.
- Job status and most recent result.
- Manual notification dispatch.
- Digest preview for the current administrator.

Do not expose arbitrary recipient selection or raw outbox payloads in the first
release.

## 8. Frontend plan

### 8.1 Calendar page

Add `src/pages/calendar/index.tsx` and components under
`src/components/Calendar/`.

Desktop:

- Month view as the default.
- Week/list toggle.
- Sticky filters for Mine/All, Movies/TV, source, and 4K.
- Cards show poster thumbnail, title, episode notation, date-type badge,
  request state, and availability.
- Selecting a card opens a details panel with all known dates and links.

Mobile:

- Agenda/list view by default rather than compressing a month grid.
- Date separators and compact cards.
- The same filters in a slideover.

States:

- Skeleton loading.
- Empty personal calendar with explanation and Discover link.
- Partial-source warning with last successful sync.
- Accessible error and retry state.
- Stale data is shown with a warning instead of blanking the calendar.

Date handling:

- Fetch bounded visible ranges, not the entire database.
- Interpret all-day events in the user's timezone without shifting the date.
- Render timed episodes in the user's timezone.
- Locale-aware date formatting using the existing internationalization stack.
- Visually mark today, delayed events, moved-earlier events, and newly announced
  seasons without relying only on color.

Add a Calendar item to the main navigation and a small upcoming widget to the
home/discover page only after the main page performs well.

### 8.2 Upcoming requested view

Implement as the Calendar page's default personal filter, plus a compact agenda
option. Each item should show:

- Request state and requested quality.
- Movie release type or TV season/episode.
- Countdown for dates within 30 days.
- Changed-date indicator with previous date.
- Request action for an unrequested new season.
- Watch action when available and a Jellyfin link exists.

Avoid creating a separate route with duplicated fetching and rendering logic.

### 8.3 Notification and digest settings

Add a Digest & Calendar section to user notification settings:

- Timezone.
- Daily digest enabled/time.
- Weekly digest enabled/day/time.
- Upcoming release toggle.
- New season toggle.
- Release changes/delays toggle.
- Recommendation digest toggle with Trakt connection status.
- Request available cadence: immediate, daily digest, off.
- Movie date preference.
- "Send preview" action.
- Explanation that each agent still needs the corresponding notification type
  enabled.

Extend `NotificationTypeSelector` with the new bitmask options. Keep the same
values in the client and server; preferably move to one shared import to remove
the current duplicated enum.

### 8.4 Digest templates

Create a responsive email digest template rather than stacking existing single
event templates. It should have a simple editorial hierarchy, section-level
headings, compact cards, and one primary action per item.

For short-message agents:

- Send one message per digest where platform limits allow.
- If splitting is unavoidable, split by section and label parts; do not revert
  to one message per title.
- Truncate safely and add a View full digest/calendar link.
- Ensure Discord/Slack field and embed count limits are respected.

The preview endpoint should exercise the real formatter with fixture data.

### 8.5 Internationalization and accessibility

- Add English source strings through the existing `defineMessages` pattern and
  generated locale workflow.
- Do not block release on translations, but preserve translation keys and avoid
  hard-coded English in server templates.
- Calendar controls require keyboard navigation and visible focus.
- Every icon needs a label or accessible text.
- Statuses such as delayed/available need text in addition to color.
- Email CTA and digest structure should remain understandable with images off.

## 9. Delivery phases

### Phase 0 — Contracts and decisions

Deliverables:

- Confirm supported Sonarr/Radarr versions and capture representative calendar
  fixtures.
- Confirm calendar visibility/privacy decision with maintainers.
- Confirm default notification cadences and retention.
- Write an architecture decision record for durable outbox + digest compilation.
- Define shared enums and API response types.

Exit criteria:

- Fixtures cover Radarr's three date types and Sonarr episodes/new seasons.
- Product decisions in section 2 are accepted or amended.
- Migration and rollback approach is reviewed for SQLite and PostgreSQL.

### Phase 1 — Unified calendar foundation

Deliverables:

- Servarr calendar API methods and contract tests.
- `ReleaseOccurrence` entity and migrations.
- Release sync service, scheduled job, manual run, and operational logging.
- Authenticated calendar range API.
- Calendar page with Mine/All, media type, source, and quality filters.
- Upcoming requested agenda.

Exit criteria:

- Results from multiple healthy instances appear in one ordered view.
- One failed instance produces a visible partial-data warning without losing
  other data.
- Personal results match movie, season, and partial-episode requests correctly.
- Dates render correctly in at least UTC and two DST-observing timezones.

### Phase 2 — Date changes and new seasons

Deliverables:

- `ReleaseDateChange` entity and comparison logic.
- New-season detector and relevance resolver.
- UI badges/history for delays, moves, announcements, and withdrawals.
- Initial-backfill suppression.
- Tests for repeated moves, withdrawn/re-added dates, specials, 4K duplicates,
  and upstream outages.

Exit criteria:

- A date update creates one accurate change record.
- Repeated changes before delivery coalesce to the original and final dates.
- New seasons alert only related users and never auto-request content.
- Re-running sync with identical data creates no changes.

### Phase 3 — Durable notifications and digests

Deliverables:

- Outbox/delivery entities and migrations.
- Per-user digest settings and validation.
- Dispatcher, compiler, cleanup job, leases, retries, and idempotency.
- New notification enum values and selector UI.
- Email digest template plus compact renderers for every enabled agent.
- Preview/test flow.

Exit criteria:

- Ten release events produce one digest per chosen agent.
- Empty digests are not sent.
- Restarting during a send does not duplicate a completed delivery.
- Partial agent failure retries only what is needed.
- DST changes do not skip or double-send a user's digest.

### Phase 4 — Actionable availability

Deliverables:

- Availability producer routed through the outbox.
- Immediate/daily/off preference.
- Direct Jellyfin/Emby CTA across capable agents.
- Safe Foreseerr fallback URL.
- Scanner/subscriber integration and end-to-end tests.

Exit criteria:

- A completed request with a Jellyfin media ID opens the correct title.
- Missing direct-link data falls back cleanly.
- The same availability transition is sent once.
- A user selecting daily receives it in one digest, not an immediate message.

### Phase 5 — Weekly personal recommendations

Deliverables:

- Trakt recommendation producer and filtering.
- Weekly settings and connection-state UI.
- Recommendation digest section and request actions.
- Rate-limit, token-refresh, revoked-account, and low-candidate handling.

Exit criteria:

- A linked user receives up to the configured number of eligible personal
  recommendations once per local week.
- Available, requested, and blocklisted titles are excluded.
- An unlinked user is prompted to connect a source and receives no misleading
  "personal" section.
- Provider failure does not prevent unrelated digest sections from sending.

### Phase 6 — Hardening and optional calendar feed

Deliverables:

- Performance/load tests and query tuning.
- Accessibility and translation review.
- Retention cleanup verification.
- Operational documentation and troubleshooting guide.
- Optional revocable ICS feed after a separate security review.

Exit criteria:

- Calendar range queries meet the agreed latency target on a representative
  large library.
- Jobs and queues remain bounded after simulated weeks of activity.
- No credentials or private requester data appear in APIs, logs, webhooks, or
  feeds.

## 10. Testing strategy

### 10.1 Unit tests

- Sonarr and Radarr response normalization.
- Movie preferred-date fallback.
- UTC, all-day, and DST calculations.
- Relevance for movie, series, season, and episode requests.
- New-season detection excluding specials.
- Change classification and significance threshold.
- Dedupe keys and coalescing.
- Digest window calculation and section limits.
- Candidate filtering for recommendations.
- URL selection and validation for Jellyfin/Foreseerr CTAs.

Use fake clocks; do not make these tests depend on the machine timezone or real
current date.

### 10.2 Database integration tests

Run critical cases against SQLite and PostgreSQL:

- Concurrent upserts keep occurrence uniqueness.
- First sync creates no historical change spam.
- Idempotent sync produces no duplicate occurrences/events.
- Lease acquisition is atomic.
- Expired leases recover after a simulated crash.
- User/media deletion follows the intended cascade or `SET NULL` behavior.
- Cleanup deletes only data outside retention.

### 10.3 Route tests

- Authentication and ownership checks.
- `mine` versus `all` privacy.
- Admin-only filters.
- Range and enum validation.
- Partial-source metadata.
- Preference access through `isOwnProfileOrAdmin`.
- No Trakt credentials or notification payload internals in responses.

### 10.4 Agent contract tests

Create shared fixtures and verify every agent handles:

- Immediate availability with direct link.
- Availability fallback link.
- Daily digest with several sections.
- Weekly digest with recommendations.
- Missing poster/overview/date.
- Platform length limits.
- Escaped user/provider text and valid webhook JSON.

### 10.5 Browser tests

Add Cypress coverage for:

- Calendar navigation and filters.
- Mobile agenda behavior.
- Upcoming requested matching.
- Delay/new-season badges and detail panel.
- Digest preference validation and saving.
- Trakt disconnected state.
- Notification preview.
- Keyboard navigation and core accessibility checks.

### 10.6 End-to-end scenarios

1. Request a movie, sync a future Radarr date, move it later, run the digest,
   import it into Jellyfin, and receive one linked availability notification.
2. Request season 1, introduce season 2 in Sonarr, verify a new-season digest
   item and that no automatic request occurs.
3. Request selected episodes, verify unrelated episode dates do not appear under
   Mine.
4. Configure standard and 4K instances for one title and verify UI combination
   without data loss.
5. Fail one Servarr instance and one notification agent, then verify partial
   calendar results and isolated delivery retry.

## 11. Observability and operations

Add structured logging with correlation IDs for sync run, digest compilation,
delivery, user ID, and agent. Never log provider tokens, Jellyfin credentials,
email bodies, webhook secrets, or full outbox payloads.

Track at minimum:

- Last successful release sync per Servarr instance.
- Occurrences fetched/inserted/updated/missing/unmapped.
- Date changes and new seasons detected.
- Pending outbox age and count by delivery class.
- Digests compiled, skipped-empty, sent, partial, failed, and retried.
- Agent delivery latency/error counts.
- Recommendation candidates fetched/filtered without logging personal titles at
  normal log level.

Admin job/status UI should show actionable failures such as authentication,
version incompatibility, stale source, or invalid external URL.

## 12. Performance and retention

- Calendar queries must always be range-bounded and indexed.
- Fetch calendar data in bounded windows and cap concurrent upstream requests.
- Cache poster/metadata enrichment; avoid one TMDB request per visible row.
- Batch media/request relevance queries to avoid N+1 database access.
- Keep current occurrences while active; purge rows missing upstream for more
  than the configured grace period if they have no retained change history.
- Retain sent delivery/event metadata for 90 days by default.
- Retain release date change history for one year by default, then compact or
  delete it.
- Make cleanup incremental so it does not lock a large SQLite database.

Before finalizing indexes, measure with a fixture representing multiple Servarr
instances, thousands of movies, hundreds of series, and at least one year of
episodes.

## 13. Security and privacy review

- Require authentication on all calendar APIs.
- Apply ownership/permission checks server-side; UI hiding is not authorization.
- Store only stable IDs and necessary display metadata in notification payloads.
- Sanitize/escape titles and overviews in HTML, Markdown, and webhook outputs.
- Validate all outbound CTA URLs and restrict them to HTTP(S).
- Never append Jellyfin API keys or user access tokens to notification URLs.
- Treat ICS tokens as credentials: high entropy, hashed at rest, revocable, and
  excluded from logs.
- Rate-limit previews/test notifications and manual job triggers.
- Prevent an administrator's preview from impersonating another recipient.
- Document that notification providers receive the content included in their
  messages.

## 14. Migration and rollout

1. Ship schema and sync code behind disabled feature flags.
2. Run initial occurrence backfill with notifications suppressed.
3. Validate source counts and mappings in logs/admin status.
4. Enable the calendar UI for administrators, then all authenticated users.
5. Enable date-change/new-season event creation without delivery and inspect
   dedupe/coalescing for several sync cycles.
6. Enable digest previews, then opt-in delivery for administrators/test users.
7. Roll out daily digests; keep weekly recommendations opt-in.
8. Route availability through the outbox after direct-link coverage is verified.
9. Remove temporary feature flags only after queue size, retries, and duplicate
   rate remain healthy.

Rollback must be safe at each step:

- Disabling producers stops new events but preserves calendar data.
- Disabling dispatch prevents sends without losing pending events.
- Existing immediate `MEDIA_AVAILABLE` delivery remains available as a temporary
  compatibility path until the outbox rollout completes.
- Do not drop new tables during an application rollback; leave them unused until
  a forward migration or deliberate maintenance release.

## 15. Definition of done

The complete feature is done when:

- Users can browse a single, timezone-correct Sonarr/Radarr calendar.
- The default view accurately identifies their upcoming requested content.
- New seasons and meaningful release-date changes are detected idempotently.
- Informational events arrive as one useful digest instead of notification spam.
- Availability remains timely and opens the requested item directly in
  Jellyfin/Emby whenever possible.
- Linked users can opt into a filtered weekly Trakt recommendation digest.
- All current notification agents have defined behavior for the new payloads.
- SQLite and PostgreSQL migrations and tests pass.
- Privacy, retry, restart, stale-source, accessibility, and DST cases are tested.
- Administrators can observe sync/delivery health and recover from failures
  without editing the database.

## 16. Suggested implementation sequence by pull request

Keep pull requests reviewable and deployable independently:

1. Shared calendar types, Servarr methods, and fixtures.
2. Release occurrence entity/migrations and sync service.
3. Calendar API, relevance resolver, and route tests.
4. Calendar/agenda UI and navigation.
5. Date-change history and new-season detection.
6. Outbox/delivery schema and idempotent dispatcher.
7. User cadence preferences and notification bitmask additions.
8. Email digest renderer and preview.
9. Remaining notification-agent digest renderers.
10. Availability outbox routing and Jellyfin direct CTAs.
11. Weekly Trakt recommendation producer and UI.
12. Retention, load testing, operations documentation, and optional ICS design.

Each pull request should include migrations where needed, unit/integration tests,
API documentation updates, English localization keys, and a rollback note.
