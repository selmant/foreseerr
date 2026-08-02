# Library Series UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Series Play resolves to next/resume/rewatch episodes, Library gains a season/episode slide-over plus Recently Added Episodes, and View details still reaches `/tv/{id}`.

**Architecture:** Foreseer server resolves `playItemId` for series rows (resume → next unwatched → first non-special episode) using the user-linked Jellyfin token. New Library endpoints feed `LibrarySeriesPanel`. Native desktop still only receives concrete item ids via `playItem`.

**Tech Stack:** Express + TypeORM SeerrSuggestArr server, Next.js React UI, Jellyfin HTTP API, OpenAPI (`seerr-api.yml`), node:test.

**Spec:** `docs/superpowers/specs/2026-08-02-library-series-ux-design.md`

---

## File map

| File | Responsibility |
| --- | --- |
| `server/interfaces/api/libraryInterfaces.ts` | Extended `LibraryTitle`, shelf id, panel response types |
| `seerr-api.yml` | OpenAPI schemas + paths |
| `server/api/openapi-library-contract.test.ts` | Contract assertions |
| `server/lib/libraryPlayTarget.ts` | Pure next/resume/rewatch resolver + tests |
| `server/api/jellyfin.ts` | `getUserLatestEpisodes`, `getNextUpEpisodes`, series episode helpers |
| `server/lib/library.ts` | Map enrichment, recent-episodes shelf, series detail builders |
| `server/routes/library.ts` | New series/season routes |
| `src/components/Library/LibrarySeriesPanel.tsx` | Slide-over UI |
| `src/components/Library/LibraryPlayCard.tsx` | Pass play/series ids + open panel |
| `src/components/Library/index.tsx` | Panel state + shelf order |
| `src/components/TitleCard/index.tsx` + `TmdbTitleCard.tsx` | Play uses `playItemId`; TV library click opens panel |
| `foreseer-desktop/docs/integration-plan.md` | One-line Library series note |

---

### Task 1: Types + OpenAPI contract

**Files:**
- Modify: `server/interfaces/api/libraryInterfaces.ts`
- Modify: `seerr-api.yml` (`LibraryTitle`, `LibraryShelf.id`, new schemas/paths)
- Modify: `server/api/openapi-library-contract.test.ts`

- [ ] **Step 1: Extend TypeScript interfaces**

Add `playItemId?`, `jellyfinSeriesId?` to `LibraryTitle`. Extend shelf id with `'recent-episodes'`. Add `LibrarySeriesSeason`, `LibrarySeriesDetailResponse`, `LibraryEpisode`, `LibrarySeasonEpisodesResponse` as in the spec.

- [ ] **Step 2: Update OpenAPI**

Mirror those fields/schemas. Add paths:

- `GET /library/series/{jellyfinSeriesId}`
- `GET /library/series/{jellyfinSeriesId}/seasons/{seasonId}/episodes`

Extend shelf enum with `recent-episodes`.

- [ ] **Step 3: Extend contract test**

Assert new paths + schemas `LibrarySeriesDetailResponse`, `LibrarySeasonEpisodesResponse`, and that `LibraryTitle` documents `playItemId` / `jellyfinSeriesId`.

- [ ] **Step 4: Run contract test**

```bash
cd /home/selmant/Projects/SeerrSuggestArr
node --import tsx --test server/api/openapi-library-contract.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/interfaces/api/libraryInterfaces.ts seerr-api.yml server/api/openapi-library-contract.test.ts
git commit -m "feat(library): extend OpenAPI for series play targets and panel"
```

---

### Task 2: Pure play-target resolver (TDD)

**Files:**
- Create: `server/lib/libraryPlayTarget.ts`
- Create: `server/lib/libraryPlayTarget.test.ts`

- [ ] **Step 1: Write failing tests**

Cover:

1. In-progress episode for series wins
2. Else first unwatched in season/episode order
3. Else first episode of first non-special season (`ParentIndexNumber`/`IndexNumber` ≥ 1 preferred)
4. No episodes → `undefined`

Use minimal episode stubs: `{ Id, SeriesId, ParentIndexNumber, IndexNumber, UserData?: { PlaybackPositionTicks?, Played?, PlayedPercentage? } }`.

- [ ] **Step 2: Implement `resolveSeriesPlayTarget(seriesId, episodes, resumeEpisodes?)`**

Return `{ playItemId, subtitle, progressPercent? } | undefined`.

- [ ] **Step 3: Run tests — PASS**

```bash
node --import tsx --test server/lib/libraryPlayTarget.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add server/lib/libraryPlayTarget.ts server/lib/libraryPlayTarget.test.ts
git commit -m "feat(library): add series next/resume/rewatch play-target resolver"
```

---

### Task 3: Jellyfin helpers

**Files:**
- Modify: `server/api/jellyfin.ts`

- [ ] **Step 1: Add helpers**

1. `getUserLatestEpisodes(limit)` — Latest with `IncludeItemTypes: 'Episode'`, `EnableUserData: true`, Fields include ProviderIds/Overview/SeriesId.
2. `getNextUpEpisodes(limit, seriesId?)` — `/Shows/NextUp` with userId + optional SeriesId.
3. Ensure `getEpisodes` / `getSeasons` request `EnableUserData: true` (or Fields that include UserData) so watched/progress work in the panel.

- [ ] **Step 2: Commit**

```bash
git add server/api/jellyfin.ts
git commit -m "feat(jellyfin): add latest-episodes and next-up helpers for Library"
```

---

### Task 4: Enrich Library titles + watch-now shelves

**Files:**
- Modify: `server/lib/library.ts`

- [ ] **Step 1: Enrich mapping**

When mapping:

- Episode → `playItemId = item.Id`, `jellyfinSeriesId = item.SeriesId`, keep subtitle
- Movie → `playItemId = item.Id`
- Series → set `jellyfinSeriesId = item.Id`; leave `playItemId` for enrichment pass

- [ ] **Step 2: Batch-enrich series play targets**

After building resume + next-up (+ optional per-series episode fetch for leftovers):

- For each series title missing `playItemId`, resolve via resume match → next-up match → `resolveSeriesPlayTarget` using fetched episodes
- Cap expensive per-series fetches (e.g. forgotten/available page size ≤ 24)

- [ ] **Step 3: Add `recent-episodes` shelf**

Between `recent` and `forgotten`. Title: `Recently Added Episodes`. Source: `getUserLatestEpisodes(16)`.

- [ ] **Step 4: Series detail builders**

`getLibrarySeriesDetail(userId, seriesId)` and `getLibrarySeasonEpisodes(userId, seriesId, seasonId)` returning panel payloads + shared resolver for header Play.

- [ ] **Step 5: Commit**

```bash
git add server/lib/library.ts
git commit -m "feat(library): resolve series play targets and recent-episodes shelf"
```

---

### Task 5: Series panel routes

**Files:**
- Modify: `server/routes/library.ts`

- [ ] **Step 1: Wire GET handlers** for series detail + season episodes (401 if no user; map codes to JSON body).

- [ ] **Step 2: Smoke typecheck server**

```bash
pnpm typecheck:server
```

- [ ] **Step 3: Commit**

```bash
git add server/routes/library.ts
git commit -m "feat(library): add series season/episode panel API routes"
```

---

### Task 6: LibrarySeriesPanel + card wiring

**Files:**
- Create: `src/components/Library/LibrarySeriesPanel.tsx`
- Modify: `src/components/Library/LibraryPlayCard.tsx`
- Modify: `src/components/Library/index.tsx`
- Modify: `src/components/TitleCard/index.tsx`
- Modify: `src/components/TitleCard/TmdbTitleCard.tsx`

- [ ] **Step 1: Panel component**

Use existing `SlideOver`. Fetch series detail + episodes via SWR. Header: Play next + Link View details. Season chips + episode rows with Play.

- [ ] **Step 2: TitleCard libraryMode**

- Play: `playItemId ?? jellyfinItemId`
- If `mediaType === 'tv'` and `onLibraryOpen` / `jellyfinSeriesId` provided: body click calls opener instead of navigating to `/tv/{id}`
- Movies unchanged

- [ ] **Step 3: Library page owns panel state**

`selectedSeriesId` + optional tmdb/title seed from clicked card. Pass opener into cards.

- [ ] **Step 4: Client typecheck**

```bash
pnpm typecheck:client
```

- [ ] **Step 5: Commit**

```bash
git add src/components/Library src/components/TitleCard
git commit -m "feat(library): add series slide-over and next-up Play wiring"
```

---

### Task 7: Docs + verify

**Files:**
- Modify: `/home/selmant/Projects/foreseer-desktop/docs/integration-plan.md` (Library series Play = episode id; panel web-owned)
- Deploy SeerrSuggestArr via foreseer-homelab-deploy skill

- [ ] **Step 1: Doc note + commit in foreseer-desktop if dirty only for that note**
- [ ] **Step 2: `pnpm typecheck && pnpm test` in SeerrSuggestArr**
- [ ] **Step 3: Push develop, pin `foreseer-src`, deploy-rs foreseer, verify public API**

---

## Spec coverage check

| Spec requirement | Task |
| --- | --- |
| Series Play = resume/next/rewatch | 2, 4 |
| Card click → slide-over | 6 |
| View details → `/tv/{id}` | 6 |
| Recently Added Episodes shelf | 4 |
| Keep Recently Added movies+series | 4 |
| OpenAPI registration | 1 |
| Episode cards open series panel | 6 |
| Native play-only unchanged | 6 (playItem id only) |
