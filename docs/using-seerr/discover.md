---
title: Discover
description: Browse TMDB, Trakt, AniList, Simkl, and MDBList rows on the Discover page.
---

# Discover

The Discover home page is a stack of sliders. Built-in rows come from TMDB,
Trakt, AniList, and Simkl. Admins can reorder, hide, or add custom sliders,
including public Trakt and MDBList lists and a named AniList list.

Requests stay manual. Pinning a list does not auto-request titles.

## TMDB

These rows work with no extra API keys (Foreseerr already uses TMDB):

- Trending, popular movies/series, upcoming, genres, studios, and networks
- Custom sliders for a TMDB keyword, genre, studio, network, search query, or
  streaming-provider set

## Trakt

Requires a Trakt app in **Settings → Integrations**, then each user links
their account under **Linked Accounts**.

Built-in rows (hidden until the user is linked):

- Recommendations
- Watchlist
- History

Custom **Trakt List** sliders accept a public `trakt.tv` URL, `username/slug`,
or a list from search. Linked users can also pick their own or liked lists.

Full list pages support movie/TV/anime filters and hide-watched.

See [Integrations](settings/integrations.md#trakt).

## AniList

Requires AniList app credentials in **Settings → Integrations**.

These catalog rows work with the app credentials only (no per-user link):

- Trending
- This Season
- Popular
- Top 100
- Next Season

These rows need a linked AniList account (**Linked Accounts**):

- Watching
- Planning
- Completed
- Custom **AniList List** (pick one of that user’s lists by name)

Titles are mapped to TMDB through the [mapping layer](advanced/mapping-packs.md).
Items that still have no TMDB match can appear as source cards instead of
being dropped. Admins can hide those cards or repair the mapping in
**Settings → Mapping**.

See [Integrations](settings/integrations.md#anilist).

## Simkl

Requires a Simkl Client ID in **Settings → Integrations**, then each user
links their account under **Linked Accounts** with a PIN.

Built-in rows (hidden until the user is linked):

- Trending
- Best
- Premieres

Library sync and watched/rating actions run while a Simkl-backed surface is
open, or when the user refreshes it. Custom Simkl lists are not supported.

See [Integrations](settings/integrations.md#simkl).

## MDBList

Requires a free MDBList API key in **Settings → Integrations**. The same key
powers rating badges and list browse (they share the daily quota).

There is no built-in MDBList home row. Admins add a custom **MDBList List**
slider, then search public lists or paste:

- `https://mdblist.com/lists/{user}/{slug}`
- `{user}/{slug}`
- a numeric list id

Movie and show variants that share a slug are merged. Items without a TMDB id
are dropped. Personalized MDBList recommendation lists and “My Lists” are not
wired yet.

See [Integrations](settings/integrations.md#mdblist).

## Customizing the page

Users with Discover edit permission can:

1. Open Discover and enter edit mode.
2. Reorder or enable/disable built-in sliders.
3. Create a custom slider (TMDB, Trakt list, AniList list, or MDBList list).
4. Save. Custom sliders start disabled until you enable them.
