---
title: Mapping
description: See how Discover sources are matched to TMDB and correct the ones that are not.
sidebar_position: 9
---

# Mapping

**Settings → Mapping** is the administration page for Foreseerr’s external-ID
layer. Discover sources speak Simkl, AniList, IMDb, TVDB, and similar ids;
Foreseerr details pages are TMDB. Mapping is what connects them.

For how a match is found, dataset mirrors, and the coverage script, see
[Mapping datasets](../advanced/mapping-packs.md).

## Datasets

The anime mapping datasets download on their own and refresh on the
**Mapping Dataset Refresh** job. The table shows how many edges each one
holds, when it last refreshed, and any error from the last attempt. You can
refresh one now or disable it. Disabling removes its data; enabling downloads
it again in the background.

## Unmapped

Items no step could match, most-seen first, with the Discover row they were
seen in. Each is retried on its own every 12 hours. **Fix** stores a
correction; **Dismiss** removes the row until the item is seen again.

## Guessed

Anime matched by the fallback because no dataset knows it yet: an exact title
match on TMDB, or the show of its prequel. These render as normal tiles and
are replaced once a dataset has the id. **Correct** one that is wrong, or
**Discard** it to have it worked out again.

## Corrections

Your own matches. A correction wins over every automatic step, and nothing
changes it but you. Leave the TMDB id empty to record that a title has no TMDB
entry, which stops it from being looked up or listed again. Corrections can be
exported and imported as JSON; override files exported before the mapping
rebuild still import.

## Discover cards

Unmapped Discover items can still appear as source-only cards (Simkl/AniList
poster and a link to the source). Hide those cards in Discover filters, or
fix them from the card or from this page so they open Foreseerr details.
