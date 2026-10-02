# Mapping redesign — a lookup into TMDB, not an identity graph

Date: 2026-10-02  
Status: implemented 2026-10-02 (see “As built” at the end for where the code differs from this proposal)  
Scope: `server/lib/mapping/**`, `server/entity/Mapping*.ts`, mapping settings route and UI, and the thin callers in `lib/anilist`, `lib/trakt`, `lib/discover`, `lib/mediaActions`, `api/animelist.ts`.

## Problem

The mapping layer is about 11,500 lines (5,660 core, 3,400 tests, 490 entities, 1,660 route + UI, 290 migrations), with seven tables, four packs in five formats, five live resolvers, per-source trust scores, token buckets, circuit breakers, and a review queue. It still leaves new anime unmapped, and most of its fix history (`disambiguateFranchiseCandidates`, `pickByTitle`, `partitionPackRecord`, `sameCanonicalTmdb`, `scrub.ts`) repairs damage the model itself causes.

## What the app actually needs

| # | Need | Callers |
| --- | --- | --- |
| N1 | Source id → TMDB id + media type, for Discover tiles | `discover/resolveItems`, `anilist/mapping`, `trakt/mapping`, `simklCatalog`, `routes/discover/mdblist` |
| N2 | Detect a dead TMDB id and repair it from the item's other ids | `discover/validity` |
| N3 | TMDB show/season/episode ↔ anime entry + episode, for AniList and Simkl sync | `mediaActions/anilistEpisodes`, `mediaActions/simklEpisodes` |
| N4 | TMDB season → TVDB season(s), for Sonarr | `sonarrRequestRouting` |
| N5 | AniDB id → TVDB/TMDB, and "this specials episode is really a film" | Plex and Jellyfin scanners via `api/animelist` |
| N6 | Manual correction, and a list of what failed | settings route + UI |

Every need is either "into TMDB" or "between an anime entry and a TMDB/TVDB season". Nothing needs arbitrary any-to-any resolution across 14 namespaces. `kitsu`, `livechart`, `animeplanet`, and `anisearch` have no consumer outside the mapping layer.

## Findings (measured 2026-10-02)

Sample: AniList top 1,000 by popularity, top 200 trending, and the top 150 each of Summer and Fall 2026. Datasets downloaded the same day.

### 1. The back catalogue is solved; new releases are the gap

| Sample | Any dataset reaches TMDB |
| --- | --- |
| Top 1,000 popular | 100% |
| Trending (196) | 93.4% |
| Summer + Fall 2026 (200) | 65.0% |

Every unmapped title is from 2026 or 2027. Coverage is a freshness problem, not a breadth problem.

### 2. The live id resolvers cannot close that gap

For 12 unmapped seasonal titles, `api.ani.zip` and `arm.haglund.dev` returned a TMDB id for 0 of 12. They are downstream of the same curated data as the packs. Wikidata had a TMDB id for 7 of 77. In the current code:

- `kitsu` exposes no TMDB ids and `MappingService.resolve` is single-hop, so it never contributes to a TMDB lookup.
- `simkl-live` offers anime TMDB ids at confidence 35, and the service discards live answers below 50, so it never contributes for anime. For non-anime, `tmdb-find` already answers from the IMDb id.
- `anizip` and `mdblist-batch` duplicate the packs and `tmdb-find` respectively.

`tmdb-find` is the only live resolver doing work. `budget.ts` (504 lines), `providerHealth.ts`, `MappingSourceUsage`, and the backfill job exist to govern the others.

### 3. The "independent sources" share one ancestor

Fribb is generated from an anime-offline-database fork joined with Anime-Lists. Kometa Anime-IDs is Anime-Lists. anibridge aggregates Anime-Lists, anime-offline-database, AnimeAggregations, shinkro-mapping and Wikidata, then applies about 4,000 manual edits. Agreement on AniList → TMDB where two datasets both answer: anibridge vs animeApi 98.9%, anibridge vs Fribb 95.7%. In 313 of the 331 Fribb disagreements one dataset says show and the other says movie; only 18 are the same type with a different id. Trust scores and "two sources agreeing" weigh copies of the same fact. (`runLayer` also accepts a single candidate anyway, so corroboration is not enforced.)

### 4. Clustering manufactures the ambiguity

anibridge is not a set of equivalence records. It is a directed, already-closed table: every provider appears as a source key, and each edge carries a season scope and episode ranges (`anilist:1225 → tmdb_show:62913:s2 {"1-3":"1-3"}`). The ingest flattens each key and all its targets into one cluster and merges clusters that share an id. A film filed at `tvdb_show:X:s0` or an `anidb:N:S` specials descriptor then pulls its whole franchise together.

| Top 1,000 popular | AniList ids left with more than one TMDB work |
| --- | --- |
| Cluster-style union (current model) | 84 |
| Direct edge, target type chosen by AniList format | 1 |

No AniList entry in anibridge spans more than one `tmdb_show`.

### 5. A derived fallback closes most of the gap, precisely

Two rules, tried in order, for an anime id no dataset knows:

- **A. Exact title.** Search TMDB with the AniList native title (then romaji, then English); accept only a single hit whose `original_name` or `name` matches exactly after normalisation, whose year is within one, and which carries the Animation genre.
- **B. Prequel chain.** For series formats, walk AniList `PREQUEL` relations to the nearest ancestor with a known `tmdb_show`.

Scored against 963 popular titles with a known anibridge answer, pretending each was unmapped:

| | Answered | Precision |
| --- | --- | --- |
| First pass | 95.2% | 98.5% (14 wrong) |
| After requiring the Animation genre | 94.7% | 99.5% (5 wrong) |

The second row was tuned on the same sample, so treat 98.5% as the honest figure. Remaining errors are differently-named sequels TMDB keeps as separate shows (Naruto → Shippuden, via rule B) and recap specials with their own TMDB record.

Applied to the titles no dataset knows: 53 of 77 resolved. Seasonal coverage goes from 130/200 to 176/200 (65% → 88%), trending from 183/196 to 195/196. The remaining 24 are mostly children's shorts with no TMDB record. This was measured with all three datasets feeding rule B.

The current heuristic cannot do this: it gates on year, which fails every sequel (TMDB's year is season one's), and its output is quarantined for manual review.

### 6. Defects found along the way

- anibridge emits `imdb_movie:*` descriptors; `NAMESPACES` only has `imdb` and the manifest has no `namespaceMap`, so all 12,189 IMDb edges are dropped at parse.
- Trakt items are looked up as `trakt:<slug>`; animeApi's `trakt` field is the numeric id. The lookup cannot match.
- Anime-Lists now carries `tmdbtv`, `tmdbseason`, `tmdboffset` on 7,076 records; the XML parser reads only `tmdbid`.
- The manifest says Fribb is MIT and frozen since 2026-07-07. It was last regenerated 2026-09-29 from a new upstream, and the repository has no licence file.
- `episodeGroups.ts` (222 lines), `simklMappedTvdbSeasons`, and `resolveMany` have no callers.
- Each pack is held three times: file on disk, parsed `PackIndex` in memory (animeApi is 33 MB of JSON), and graph rows.

### Upstream status

| Dataset | Last update | Licence | Verdict |
| --- | --- | --- | --- |
| anibridge-mappings v3 | asset 2026-09-26, commits 2026-09-12 | MIT | Primary. Only one with TMDB season + episode ranges. README says daily; currently six days behind |
| Fribb/anime-lists | 2026-09-29 | none | Gap filler. Fresher on new titles |
| Anime-Lists/anime-lists | 2026-10-02 | none | Upstream of both; AniDB-keyed, so not directly usable from AniList |
| nattadasu/animeApi | 2026-10-02 | MIT | Drop. Adds 361 unique ids overall; its Trakt/Simkl ids are not needed to reach TMDB |
| Kometa Anime-IDs | 2026-10-02 | MIT | No TMDB ids |
| manami anime-offline-database | archived 2026-07-04 | — | Dead |
| PlexAniBridge-Mappings | archived 2026-04-05 | — | Superseded by anibridge |

## Design

Stop modelling identity. Store what the dataset states, look it up in one hop, and compute the rest.

### Tables (two, replacing seven)

`anime_edge` — the anibridge release, as stated, replaced wholesale on refresh.

| Column | Notes |
| --- | --- |
| `srcNs`, `srcId`, `srcScope` | `anilist` / `1225` / `''`; `tmdb_show` / `62913` / `s2`; `anidb` / `3` / `R` |
| `dstNs`, `dstId`, `dstScope` | same shape |
| `srcRange`, `dstRange` | episode ranges, nullable |
| `dataset`, `generation` | for atomic swap |

Index on `(srcNs, srcId)`. About 258k rows. Refresh bulk-inserts a new generation in chunks, flips the active generation in one statement, then deletes the old one. No cluster lookups per record, no in-memory index, no "rewrite in flight" state.

`mapping_resolution` — every answer that is not a dataset edge, and every miss.

| Column | Notes |
| --- | --- |
| `srcNs`, `srcId`, `mediaType` | unique |
| `tmdbId` | null means a recorded miss |
| `origin` | `manual`, `tmdb-find`, `fribb`, `title`, `prequel` |
| `title`, `year`, `discoverSource`, `hitCount` | for the unmapped list |
| `checkedAt` | misses and derived answers are retried after a TTL |

Manual rows are the overrides. Null rows are the gap queue. Derived rows are never copied into `anime_edge`, and a dataset edge that appears later supersedes them, so a wrong guess heals when the dataset catches up.

### Resolution order

A fixed order, first answer wins. No numeric trust, no confidence, no corroboration.

1. `manual` row.
2. Dataset edge. Target namespace comes from the source's declared format (AniList `MOVIE` → `tmdb_movie`, otherwise `tmdb_show`). If the direct edge is missing, one pivot hop through the entry's own `mal` or `anidb:*:R` edge, nothing else.
3. TMDB id supplied by the source (Trakt, MDBList, Simkl non-anime), confirmed alive.
4. TMDB `/find` by IMDb or TVDB id.
5. Fribb, only for ids anibridge does not contain.
6. Derived: exact title, then prequel chain.
7. Recorded miss.

Measured for step 2 alone: 99.2% of the top 1,000, one ambiguous id. Step 5 adds 12 points on seasonal titles and 3 on trending.

### API (purpose-built, replacing `MappingService.resolve(from, to, options)`)

- `toTmdb(ref, { mediaType, title, year, nativeTitle })` → `{ tmdbId, mediaType, season?, origin }` — N1, N2.
- `animeEntriesFor(tmdbShowId, season)` → entries with ranges — N3.
- `translateEpisode(descriptor, episode, targetNs)` → one edge lookup plus range arithmetic — N3, N4.
- `fromAnidb(anidbId)` and `specialAt(tvdbId, episode)` — N5.

`parseEpisodeRange`, `applyEpisodeRule`, `invertEpisodeRule`, `absoluteFromSeasons` are correct and tested; they carry over unchanged. So does the dead-id probe in `validity.ts`.

### Removed

`graph.ts` and the cluster/link/source/usage/gap/override/episode-rule entities; trust, priority and namespace trust; the manifest framework and four of five parsers; `PackIndex`; the Kitsu, ani.zip, Simkl, TVDB and MDBList resolvers and the backfill job; `budget.ts` and `providerHealth.ts` (the TMDB and AniList clients keep their own rate limits); `scrub.ts`; `episodeGroups.ts`; the suggestion quarantine; mirror templates, the mirror script and its Forgejo workflow (one `MAPPING_DATASET_URL` override stays). The settings page shrinks to dataset status, the unmapped list with a fix action, and the overrides list.

Estimated result: 1,500–2,000 lines including tests, against 11,500.

## Risks

- **Single primary dataset.** anibridge has one main maintainer and is six days behind its stated cadence. Mitigation: last-good copy on disk, Fribb as filler, and the derived fallback, which needs no dataset at all.
- **Derived answers are guesses.** About 1 in 70 was wrong on the first-pass measurement. They are marked by origin, shown as such in the UI, re-checked on a TTL, and superseded by the dataset.
- **Rule B and renamed sequels.** A sequel TMDB files as its own show resolves to the parent when rule A misses. Running A first limits this; the two cases in the sample were Naruto Shippuden and Magi.
- **Fribb has no licence.** It is fetched at runtime by the operator's instance, not redistributed. It can default off, at a cost of about 12 points of seasonal coverage before the fallback runs.
- **Migration.** Existing `MappingOverride` rows must be copied into `mapping_resolution` as `manual`. Everything else is rebuilt from the dataset.

## Not measured

- Non-anime sources (Trakt, MDBList, Simkl TV/movies) were assessed by reading the code, not sampled. The local database has no gap telemetry.
- Episode-range accuracy of anibridge was not checked.
- The fallback was not re-measured with animeApi removed; about 13 more seasonal titles would pass through it.

## As built

Approved 2026-10-02 with Fribb on by default; derived answers render as normal tiles and are listed under **Guessed** on the Mapping settings page.

Differences from the proposal above:

- **Three tables, not two.** `mapping_dataset` holds each dataset's enabled flag, refresh state and active generation. The generation pointer has to move in the same database as the rows it points at.
- **Both datasets share `mapping_edge`.** Fribb is not an origin in `mapping_resolution`; it is a second dataset, and a lookup uses the best-ranked dataset that reaches the wanted namespace at all. Preference is per question (id and target namespace), not per id: anibridge lists most AniList ids but has a TMDB edge for only half of them.
- **Source-supplied TMDB ids stay with the callers** (`confirmOrRepair`), ahead of the resolver, as before.
- **Derived answers are not re-checked on a timer.** They stand until a dataset or a correction supersedes them. Misses are retried after 12 hours.
- **The mirror script and its Forgejo workflow were kept** and adapted, since `MAPPING_MIRROR_TEMPLATES` is still honoured. `MAPPING_MANIFEST_URL` is gone.
- **Title-divergence review items were dropped** along with the review queue.
- **Size:** about 2,750 lines of mapping code and entities plus 1,400 of tests, against 6,150 and 3,400; the settings route and UI went from 1,660 lines to 1,010. That is roughly half the old total, not the 1,500–2,000 estimated above: the download, progress and episode-range code carried over largely intact.

Changed after an independent review of the first build:

- **Corrections win everywhere.** They also override an id the source supplied (Trakt, MDBList, Simkl, a dataset id on an AniList tile), including its media type. They are held in memory, so checking every tile costs no query.
- **Only anime entries cross media type**, and an entry that only sits in a show's specials but is a film on TMDB resolves to the film. A TVDB show id never answers with a film parked in its specials.
- **The secondary dataset is chosen per season**, so a show the primary knows up to season 2 still gets its season 3 from Fribb.
- **AniList season entries** are one per AniList id and TMDB season, with signed offsets, and specials are marked as such. Ranges are checked before the season heuristics decide there is nothing to show.
- **Failures are not misses.** An AniList rate limit or outage is held off for two minutes and nothing is stored. The fallback shares one AniList client, so its rate limiter applies, and AniList list sync uses stored answers only.
- **First boot:** the fallback waits while the datasets download for the first time, and a guess is removed once a dataset answers for that title.
- **Refreshes overtaken by a disable or re-enable** are thrown away and, after a re-enable, re-run.
- **The corrections endpoint** rejects an id that is not a positive whole number instead of saving it as "no TMDB entry". The fix modal also accepts a themoviedb.org link.

Measured end to end on 2026-10-02, with the real datasets and live TMDB and AniList, through the same code path the AniList discover route uses:

| | Result |
| --- | --- |
| Refresh of both datasets (400,069 edges) into an empty SQLite database | 11 s, longest event-loop stall 0.4 s |
| Refresh with nothing changed upstream | 0.6 s |
| Summer + Fall 2026 sample (200) mapped | 166 (83%) |
| Trending sample (196) mapped | 194 (99%) |

The seasonal figure is below the 88% measured for the proposal because that run still had animeApi feeding it: five titles only animeApi mapped, and three sequels whose prequel only animeApi mapped. One more title is lost to requiring the Animation genre. animeApi can be added as a third dataset with a parser of about forty lines; the precision of those extra matches has not been measured.

Both migrations were run against a fresh install and against seeded override rows, on SQLite and on PostgreSQL 16.
