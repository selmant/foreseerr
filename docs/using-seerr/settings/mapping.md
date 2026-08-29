---
title: Mapping
description: See how Discover sources resolve to TMDB and repair gaps.
sidebar_position: 9
---

# Mapping

**Settings → Mapping** is the administration page for Foreseerr’s external-ID
layer. Discover sources speak Simkl, AniList, IMDb, TVDB, and similar ids;
Foreseerr details pages are TMDB. Mapping is what connects them.

For pack mirrors, environment overrides, and coverage scripts, see
[Mapping packs](../advanced/mapping-packs.md).

## Health

The page summarizes open gaps, pack refresh progress, live API budgets
(token bucket, daily quota, circuit breaker), and provider access. Trakt list
search still needs a linked account; a failing Trakt health row is usually
that constraint, not a mapping-pack fault.

## Packs and live APIs

Packs refresh on the **Mapping Pack Refresh** job. You can also refresh a
single pack from this page. Live resolvers (Simkl, ani.zip, Kitsu, TMDB
`/find`, TVDB, MDBList) fill remaining gaps within their budgets.

Disable a source only when you intend it to stop contributing. After changing
source toggles, run a pack refresh if tiles still resolve through that
source’s stored graph.

## Repair queue

Items that never reached a trusted TMDB id appear as gaps. Heuristic
title/year matches show up as **suggestions** only; they are not applied
until you accept them. Ambiguous clusters stay unmapped until someone
chooses.

Use the repair modal to set an override, accept a suggestion, or leave the
gap. Overrides win over packs and live results.

## Discover cards

Unmapped Discover items can still appear as source-only cards (Simkl/AniList
poster and a link to the source). Hide those cards in Discover filters, or
repair them here so they open Foreseerr details.
