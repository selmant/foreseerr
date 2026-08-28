---
title: Mapping Packs and Mirrors
description: How Foreseerr resolves external media ids, and how to mirror the mapping packs it depends on.
sidebar_position: 6
---

# Mapping packs and mirrors

Discover sources speak in their own ids: Simkl ids, AniList ids, AniDB ids,
IMDB ids, TVDB ids. Foreseerr renders TMDB. The mapping layer is what turns one
into the other, and **Settings → Mapping** is where you can see how well it is
doing.

## The resolver chain

A lookup walks five layers in order and stops at the first one that answers:

| Layer | Source | Persisted? |
| --- | --- | --- |
| Override | Your manual corrections | Yes, and it wins over everything |
| Graph | Previously resolved links in the database | Already stored |
| Pack | Bulk mapping files refreshed daily | Yes |
| Live | Simkl, ani.zip, Kitsu, TMDB `/find`, TVDB, MDBList | Yes, with provenance |
| Heuristic | Title + year + episode count matching | **No** — suggestions only |

The heuristic layer is quarantined on purpose. A guess never becomes a mapping
on its own: it appears in the repair queue as a suggestion for you to accept or
reject. Two sources disagreeing is likewise not resolved by a coin toss; the
item is recorded as ambiguous and shown as unmapped until someone decides.

## A present id is not a valid id

An id arriving from a source proves only that an integer arrived. Ids do die:
TMDB deletes duplicate records for alternate cuts, and occasionally splits one
show into several. Before a tile is trusted, its id is confirmed to exist, and
the answer is cached so a dead id is not re-probed on every slider render.

When the id is dead, the item's other ids are tried — an Extended-cut record
usually reaches the base film through its IMDB id. Where no single answer
exists, such as a show TMDB has split into per-cour series, the item becomes a
recorded gap instead of a card that fails when clicked.

## Provider access

**Settings → Mapping** also reports providers the mapping layer depends on but
does not control. Trakt is the notable one: since it removed API access for
non-VIP accounts, requests carrying only the application `client_id` are
refused, so Trakt list search and every Trakt slider need a linked account. That
shows as a failing provider rather than as a mapping fault.

## Packs

Packs are bulk mapping files fetched daily by the **Mapping Pack Refresh** job.
Each has a mirror list; a download is written to a temporary file, validated,
and only then renamed into place, so a truncated response can never replace a
working pack.

| Pack | Role | Licence |
| --- | --- | --- |
| `anibridge` | Primary anime graph | MIT |
| `animeapi` | Trakt and Simkl anime ids | MIT |
| `fribb` | Fallback only; its AniList/MAL fields are frozen | MIT |
| `anime-lists` | Off by default: published with no licence at all | none |

`anime-lists` stays disabled until you enable it, because enabling an
unlicensed dataset is your decision, not a default.

## Overriding the manifest

The pack list is data, not code. Point `MAPPING_MANIFEST_URL` at your own JSON
manifest to add a source, repoint a dead URL, or change precedence without
waiting for a release. If the URL is unreachable or malformed, the bundled
manifest is used instead.

## Mirroring packs yourself

Upstream packs are served from GitHub raw and jsDelivr, and both have gone away
mid-day. `MAPPING_MIRROR_TEMPLATES` appends extra mirrors to every pack, where
`{key}` is the pack key:

```bash
MAPPING_MIRROR_TEMPLATES=https://packs.example.net/{key}.json,https://forgejo.example.net/mirror/packs/raw/branch/main/{key}.json
```

To populate such a mirror, run the bundled script on a schedule. It downloads
each pack from its upstream mirrors, validates the body, and publishes it to a
directory, an S3 bucket, or both:

```bash
MAPPING_MIRROR_DIR=/srv/packs pnpm mirror:packs
MAPPING_MIRROR_S3=s3://foreseerr-packs pnpm mirror:packs
```

The S3 form shells out to the `aws` CLI, so any S3-compatible store (Garage,
MinIO, Ceph) works with the usual `AWS_*` environment variables. A ready-made
daily Forgejo workflow lives at
`.forgejo/workflows/mirror-mapping-packs.yml`.

## Measuring coverage

`pnpm measure:mapping` downloads every pack in the manifest and reports how
much of it reaches TMDB, without needing a database or any API key:

```text
anibridge    74146 records   anilist 68453  →tmdb 60.7%  season-scoped 43324  episode rules 231421
animeapi     29449 records   anilist 21971  →tmdb 33.4%  season-scoped 0      episode rules 0
fribb        29402 records   anilist 20010  →tmdb 40.6%  season-scoped 0      episode rules 0
anime-lists   7654 records   anilist 0      →tmdb n/a    season-scoped 5576   episode rules 3272
```

Per-slider rates — how many tiles on `simkl/premieres anime` actually resolved —
come from the gap telemetry on the Mapping settings page, since they depend on
what your instance has served.

## Budgets

Simkl, ani.zip and Kitsu publish no rate-limit headers and never return 429, so
Foreseerr does not wait to be told to slow down. Every live source has a token
bucket, a concurrency cap, a daily quota, and a circuit breaker that opens after
repeated failures. Current token counts, daily request volume and breaker state
are all on the Mapping settings page, and each can be tuned per source.

## Jobs

| Job | Default schedule | What it does |
| --- | --- | --- |
| Mapping Pack Refresh | 04:15 daily | Conditional GET of every pack, then ingest |
| Mapping Gap Backfill | 04:45 daily | Batch-resolves the most-seen gaps, then attaches title suggestions |

Backfill is ordered by how often an item was actually rendered, so a limited
daily quota is spent on titles people see rather than on the tail of the queue.
