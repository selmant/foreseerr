---
title: Mapping Datasets and Mirrors
description: How Foreseerr matches external media ids to TMDB, and how to mirror the datasets it uses.
sidebar_position: 6
---

# Mapping datasets and mirrors

Discover sources speak in their own ids: AniList ids, Simkl ids, IMDb ids,
TVDB ids, Trakt slugs. Foreseerr renders TMDB. The mapping layer turns one into
the other, and **Settings → Mapping** shows how well it is doing. For the
administration page, see [Mapping](../settings/mapping.md).

## How an item is matched

A lookup tries six steps in a fixed order and stops at the first that answers:

| Step | Source | Stored? |
| --- | --- | --- |
| Correction | Your manual matches | Yes, and it wins over everything |
| Dataset | Bulk anime mapping files, refreshed nightly | Yes, replaced on each refresh |
| Stored answer | A result an earlier lookup worked out | Already stored |
| TMDB `/find` | TMDB's own index of IMDb and TVDB ids | Yes |
| Anime fallback | Exact title match, then the prequel's show | Yes, as a guess |
| Miss | Nothing answered | Yes, and retried after 12 hours |

There is no scoring and no voting. The anime datasets all descend from the same
curated data, so weighing them against each other only ever measured how often
a fact had been copied.

The source's declared media type decides whether a movie or a show is looked
up. It is never inferred from a TMDB response: the same integer is a valid id
in both TMDB catalogues for two unrelated titles most of the time.

## Datasets

| Dataset | Role | Licence |
| --- | --- | --- |
| `anibridge` | Primary. AniList, MAL, AniDB, TVDB and IMDb to TMDB, with season and episode ranges | MIT |
| `fribb` | Fills ids `anibridge` has no TMDB match for yet, mostly the current season | none |

Both are enabled by default and download on first start, in the background.
`fribb` publishes no licence; you can turn it off on **Settings → Mapping**, at
the cost of some current-season coverage.

A dataset is stored as published: one row per directed statement such as
`anilist:1225 → tmdb_show:62913, season 2, episodes 1–3`. Rows are never merged
or chained together, so a film filed under a show's specials cannot pull the
rest of the franchise onto one id.

A refresh writes the new copy alongside the old one and switches over when it
is complete. Lookups never see a half-written dataset, and a download that
fails or shrinks by more than half leaves the current copy in place.

## The anime fallback

Datasets cover the back catalogue but trail new releases by weeks. For an anime
none of them knows, two rules apply:

1. **Exact title.** TMDB is searched with the AniList native title, then
   romaji, then English. A match must be exact after ignoring case, spacing and
   punctuation, be within one year, and carry the Animation genre. Two exact
   matches count as no match.
2. **Prequel.** A later season is filed on TMDB under the show it continues,
   so it takes the show of its nearest prequel that has a known match.

The result is stored as a guess, listed on the Mapping page, and replaced as
soon as a dataset has the id. Measured on 963 titles with a known answer, the
fallback answered 95% and was right for 98.5% of those.

## A present id is not a valid id

An id arriving from a source proves only that an integer arrived. TMDB deletes
duplicate records for alternate cuts, and occasionally splits one show into
several. Before a tile is trusted its id is confirmed to exist, and the answer
is cached so a dead id is not re-probed on every slider render.

When the id is dead, the item's other ids are tried: an Extended-cut record
usually reaches the base film through its IMDb id. Where no single answer
exists the item is counted as unmapped instead of becoming a card that fails
when clicked.

## Episode numbering

`anibridge` states which episodes of an AniList, MAL or AniDB entry are which
episodes of a TMDB or TVDB season. That is what lets a watched TMDB episode be
written to the right AniList entry, a Simkl sync use TVDB numbering, and a
Sonarr request monitor the TVDB seasons a TMDB season actually spans.

## Mirroring datasets yourself

Upstream files are served from GitHub and jsDelivr, and both have gone away
mid-day. `MAPPING_MIRROR_TEMPLATES` adds mirrors that are tried after the
upstream URLs, where `{key}` is the dataset key:

```bash
MAPPING_MIRROR_TEMPLATES=https://packs.example.net/{key}.json,https://forgejo.example.net/mirror/packs/raw/branch/main/{key}.json
```

To populate such a mirror, run the bundled script on a schedule. It downloads
each dataset, checks that it parses, and publishes it to a directory, an S3
bucket, or both:

```bash
MAPPING_MIRROR_DIR=/srv/packs bun run mirror:packs
MAPPING_MIRROR_S3=s3://foreseerr-packs bun run mirror:packs
```

The S3 form shells out to the `aws` CLI, so any S3-compatible store (Garage,
MinIO, Ceph) works with the usual `AWS_*` environment variables. A ready-made
daily Forgejo workflow lives at
`.forgejo/workflows/mirror-mapping-packs.yml`.

## Measuring coverage

`bun run measure:mapping` downloads each dataset and reports how much of it
reaches TMDB, without needing a database or any API key:

```text
anibridge  258055 edges    ranged 258055   anilist 19135   →tmdb 47.8%   adds 9154    2026-09-26T06:57:14Z
fribb      142014 edges    ranged 6706     anilist 8424    →tmdb 97.5%   adds 519
```

The percentage is of every AniList id the dataset lists, including music
videos and shorts TMDB does not carry. For what an instance actually served,
see the Unmapped list on the Mapping settings page.

## Jobs

| Job | Default schedule | What it does |
| --- | --- | --- |
| Mapping Dataset Refresh | 04:15 daily | Conditional download of each enabled dataset, then a switch to the new copy |
