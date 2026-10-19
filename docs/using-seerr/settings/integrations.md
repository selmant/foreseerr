---
title: Integrations
description: Configure Trakt, AniList, MDBList, Simkl, Radarr, and Sonarr.
sidebar_position: 5
---

# Integrations

**Settings → Integrations** holds optional discovery sources and Radarr/Sonarr.

Discovery cards (Trakt, AniList, MDBList, Simkl) sit at the top. Health checks
show whether each service is reachable. Radarr, Sonarr, override rules, and
intervention cleanup are on the same page below those cards.

Use the section shortcuts at the top to jump to discovery, Radarr, Sonarr,
override rules, or queue cleanup. Server integrations apply to everyone;
**Linked accounts** connects your personal trackers and recommendations.

For Radarr/Sonarr field-by-field setup, see [Services](services.md).

## Trakt

Trakt powers personalized Discover rows and watched/rating actions.

1. Create an API app at [trakt.tv/oauth/applications](https://trakt.tv/oauth/applications).
2. Enter the client ID and secret in **Settings → Integrations → Trakt**, or
   switch the instance to **Better Trakt via Jellyfin** if that plugin is
   installed.
3. Direct Trakt users link in **Linked Accounts** with a device code
   (`trakt.tv/activate`). Better Trakt users link inside Jellyfin.

Once linked, Discover can show recommendations, watchlist, and history. Watched
and rating sync is on by default; users can turn it off under **Linked Accounts
→ Watch trackers** without unlinking. Admins can pin public or personal Trakt
lists as custom sliders. See [Discover](../discover.md#trakt).

Jellyfin watched state can still appear when Trakt is not linked. Direct Trakt
vs Better Trakt is a single instance-wide choice on the Trakt card.

## AniList

AniList powers anime catalog rows, personal anime lists, and optional watched /
score sync for mapped titles.

1. Create an API client at
   [anilist.co/settings/developer](https://anilist.co/settings/developer).
2. Set the redirect URL to `https://anilist.co/api/v2/oauth/pin` (Foreseerr
   shows this value on the AniList settings card).
3. Enter the client ID and secret.
4. Each user authorizes that app in **Linked Accounts** and pastes the PIN.

Catalog rows (trending, this season, popular, top 100, next season) use the
app credentials only. Watching / planning / completed and custom named lists
require a linked account. See [Discover](../discover.md#anilist).

Watched and rating sync is **on by default** once the account is linked. Admins
can turn it off instance-wide with **Allow AniList watched and rating actions**.
Each user can also turn it off under **Linked Accounts → Watch trackers**
without unlinking.

AniList season mapping is experimental: TMDB seasons and episodes are not always
1:1 with AniList, so a watch can land on the wrong title or be skipped. Prefer
repairing mappings in [Settings → Mapping](mapping.md) over guessing.

## MDBList

MDBList uses **one shared API key** for the whole instance (not per-user
OAuth).

1. Get a free key at
   [mdblist.com/preferences](https://mdblist.com/preferences).
2. Paste it in **Settings → Integrations → MDBList**.
3. Choose which rating sources appear on posters and detail pages.

The same key also lets admins pin **public MDBList lists** as custom Discover
sliders (search by name, or paste a list URL / `username/slug` / id). See
[Discover](../discover.md#mdblist).

Free keys are limited (about 1,000 requests per day). Rating badges and list
browse share that quota. Foreseerr caches list search and list pages so Discover
does not refetch on every scroll.

MDBList “My Lists” and personalized recommendation lists are not supported yet.

## Simkl

Foreseerr ships its own Simkl app, so nothing needs to be registered on Simkl: turn on **Enable Simkl** in **Settings → Integrations → Simkl**. New installs start with Simkl on. Installs that never configured Simkl before this version keep it off until an administrator turns it on.

Each user then opens **Profile → Linked Accounts**, starts the PIN flow, and authorizes the displayed code on Simkl. Tokens are stored per user, and each user's requests count against their own Simkl allowance. Simkl's V2 access tokens last seven days; Foreseerr renews them automatically. Unlinking also asks Simkl to revoke them; if Simkl cannot be reached, the account is still unlinked in Foreseerr and the access remains listed in your Simkl settings until you revoke it there. Turning Simkl off stops every Simkl call but keeps linked accounts for when it is turned back on.

Installs that registered their own Simkl app before Foreseerr shipped one keep using it, so nobody is disconnected by an upgrade. Their settings show **Switch to Foreseerr's Simkl App**; switching disconnects linked users until they link again, because Simkl only accepts a token with the app that issued it. Plan the switch before Simkl retires AUTH V1 apps, around April 2027. A custom Client ID can no longer be set.

Public Trending rows need no linked account. Plan to Watch and other personal statuses need a linked account. Foreseerr synchronizes the Simkl library only while a user is viewing a Simkl-backed surface or explicitly refreshes it. Cached results remain available when Simkl is temporarily unavailable and are marked stale. Simkl provides tracking and attribution; TMDB/TVDB remain Foreseerr's canonical metadata sources.

Every Simkl-sourced title must link to its Simkl page.

Current exclusions are custom lists, Best/Premieres catalog endpoints, automatic requests, scrobbling, calendar ingestion, and playback-resume synchronization.

See [Discover](../discover.md#simkl).
