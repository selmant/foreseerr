---
title: Discover
description: Browse TMDB, Trakt, AniList, Simkl, and MDBList rows on the Discover page.
sidebar_position: 3
---

# Discover

The Discover home page is a stack of sliders. Built-in rows come from TMDB,
Trakt, AniList, and Simkl. Admins can reorder, hide, or add custom sliders,
including public Trakt and MDBList lists and a named AniList list.

Requests stay manual. Pinning a list does not auto-request titles.

Poster cards show their title and year before you open them. **Tab** reveals a
card's quick actions; **Enter** on the card opens its details. Tab again to reach
watch status, rating, watchlist, and request controls when available.
TV cards include **More request options** beside the Season 1 shortcut when
instant requests are enabled. Choose all seasons, specific seasons, or
individual episodes. Arrow keys move through these choices; Escape returns to
the button, and Tab continues to the next card.

Use **Sources** at the top of Discover to browse every enabled provider,
even if its rows are hidden from the home feed. It includes Trakt personal
views, AniList catalog and account lists, all Simkl watch statuses, and forms
to open a public Trakt or MDBList list without pinning it. Provider pages
include shortcuts to their other views.

Use the source shortcuts to jump directly to a provider. **Integration ready**
means the provider is configured for Foreseerr; **Account connected** shows
whether your personal views are ready. A connection that needs attention links
to **Linked accounts**, while public catalog and list browsing remain available.
AniList's named-list picker includes **Refresh lists**. If refreshing fails,
previously loaded lists remain usable while you retry.

Trakt, AniList, Simkl, and MDBList title pages show how many titles are loaded and
provide **Refresh titles** and **Load more titles** controls. If loading fails,
the page keeps its filters and any loaded titles available, with **Try again**
to recover. Empty lists explain where their titles come from and suggest what
to try next.
When your preferences hide requested titles, the page explains this and links
to **Discover preferences** so you can adjust visibility.

**Discover preferences** controls your personal filter defaults. **Linked
accounts** connects your trackers and watch history. Both are available from
the Discover header, navigation, and account menu.

Preferences are grouped into visibility, title filters, and rating filters.
Save and Discard stay visible while you scroll, with an indicator for unsaved
changes. **Clear All Defaults** stages an empty set of preferences; select
**Save Changes** to apply it or **Discard** to keep your saved defaults.

Unmapped source titles can appear as source-only cards instead of being
dropped. Repair them in [Settings → Mapping](settings/mapping.md).

## Search

Use the search field above to find movies, series, or people. Typing updates
the results; **Enter** submits immediately and moves focus to the results.
**Clear search** returns to the page you started from and focuses the field
for another query.

The results page shows your query and the number of results loaded. **Refresh
results** updates the current search, and **Load more results** works alongside
automatic scrolling. Keyboard activation of Load more moves focus to the first
new result when you keep focus on that action. If a read fails, loaded cards
stay available with **Try again**. Empty results offer **Edit search** to focus
and select the query.

## TMDB

These rows work with no extra API keys (Foreseerr already uses TMDB):

- Trending, popular movies/series, upcoming, genres, studios, and networks
- Custom sliders for a TMDB keyword, genre, studio, network, search query, or
  streaming-provider set

## Trakt

Requires a Trakt app in **Settings → Integrations**, then each user links
their account under **Linked Accounts** (or Better Trakt via Jellyfin).

Built-in rows (hidden until the user is linked):

- Recommendations
- Watchlist
- History

Custom **Trakt List** sliders accept a public `trakt.tv` URL, `username/slug`,
or a list from search. Linked users can also pick their own or liked lists.

Full list pages support movie/TV/anime filters and hide-watched.

**My lists** includes lists you created and liked, with owners shown for liked
lists. Search by name or owner; the search stays in the URL for Back and shared
links. **Refresh lists** keeps your search and loaded cards available while it
updates. A failed refresh offers **Try again** without discarding loaded lists.

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

See [Integrations](settings/integrations.md#anilist).

## Simkl

Requires a Simkl Client ID in **Settings → Integrations**. Public catalog rows
need only that Client ID. Personal library rows need a PIN-linked account.

Public rows (hidden until Simkl is configured):

- Trending (movies, TV, and anime from Simkl's trending JSON files)

Personal rows (hidden until the current user is linked):

- Plan to Watch
- Watching
- On Hold
- Completed
- Dropped

`/discover/simkl` is the provider hub with the same feeds and URL-backed
filters. Every Simkl-sourced title includes a link to its canonical Simkl
page.

Use **Content type** to choose movies, series, anime, or all three. The choice
stays selected when switching between watch statuses. Trending also offers
**Time period** choices for today, this week, and this month. These choices
are stored in the page URL. An empty filtered list offers **Reset filters**.
When Simkl cannot update a personal library, the page explains that it is
showing saved titles and displays the last successful sync time when known.

Library sync and watched/rating actions run while a Simkl-backed surface is
open, or when the user refreshes it. Cached rows can show as stale if Simkl
is temporarily down. Custom Simkl lists, Best/Premieres catalog endpoints,
scrobbling, and calendar ingestion are not supported.

See [Integrations](settings/integrations.md#simkl).

## MDBList

Requires a free MDBList API key in **Settings → Integrations**. The same key
powers rating badges and list browse (they share the daily quota).

Open an MDBList list from **Sources**, or add a custom **MDBList List**
slider as an administrator. Custom sliders support list search. Both accept:

- `https://mdblist.com/lists/{user}/{slug}`
- `{user}/{slug}`
- a numeric list id

Movie and show variants that share a slug are merged. Items without a TMDB id
are dropped. Personalized MDBList recommendation lists and “My Lists” are not
wired yet.

See [Integrations](settings/integrations.md#mdblist).

## Your watchlist

Open **Your watchlist** in the sidebar, the mobile **More** menu, or the
account menu. On a movie or series page, choose **Watchlist** to save a title
for later; **On Watchlist** removes it. Requested and available titles remain
visible in your watchlist.

An empty watchlist links to Discover and explains how to save titles. Use
**Refresh watchlist** after changes, or **Load more titles** to load another
page without relying on scrolling. For a Plex account, titles come from its
Plex Watchlist. Trakt, AniList, Simkl, and MDBList feeds are available through
**Browse list sources**.

## Customizing the page

Users with Discover edit permission can:

1. Open Discover and choose **Customize Discover** in the header.
2. Reorder or enable/disable built-in sliders.
3. Create a custom slider (TMDB, Trakt list, AniList list, or MDBList list).
4. Save. Custom sliders start disabled until you enable them.
