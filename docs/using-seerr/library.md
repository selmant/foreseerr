---
title: Library
description: Continue watching and browse titles already on your Jellyfin server.
sidebar_position: 2
---

# Library

Library is Foreseerr’s Watch Now surface. It is built for **Jellyfin-linked**
accounts. Plex and Emby keep Seerr-style availability and requests; they do not
get the same Library shelves or browse.

Open **Library** in the sidebar. Use **Overview** for shelves or **Browse** to
search and filter the catalog.

## Overview shelves

When your account is linked to Jellyfin, Overview can show:

- **Continue Watching** — in-progress movies and series
- **Recently Added** — newly available titles
- **Recently Added Episodes** — new episodes
- **Ready to Watch** — your requested titles available in Jellyfin

Use the shelf shortcuts to jump to Continue Watching, new titles, new episodes,
or your requests. **Search library** opens the full catalog; **Refresh** checks
for new additions and playback progress. Ready to Watch shows your requested
titles that Jellyfin can play, including series you have already started.

Shelf arrows work with touch and keyboard. Focus a shelf and use the left/right
arrow keys to browse it. Continue Watching cards show longer title names, a
clearly labeled resume action, and approximate time remaining when available.

Empty shelves are omitted. If nothing is linked, Library tells you to link
Jellyfin in settings. Playback uses the normal Jellyfin link in a browser, or
native playback when [Foreseer Desktop](native-desktop.md) is running.

Open a poster for series/season details, resume, next-unwatched, or rewatch
choices. Episode watched/unwatched toggles apply to Jellyfin (and to Trakt or
Simkl when those providers are enabled for the user).

The title panel highlights the next episode and shows your progress. Choose a
season, search by episode name or number, or use **Hide watched** to focus on
what is left. Playback, **View Details**, and **Manage downloads** stay at the
bottom of the panel while you browse episodes. If Jellyfin cannot refresh the
title or season, use **Retry**; information already loaded stays visible.
Watch-status and rating actions keep their labels on phones.
The rating picker lets you choose any score from **1–10**, then **Save rating**.
**Cancel** closes the picker without changing your saved rating.
Open **Watch tracking** to see each service’s status and rating, refresh it,
or open tracking settings. See [Watch tracking](watch-tracking.md).

## Browse

**Library → Browse** searches and filters the Jellyfin library: watch status
(unwatched, in progress, watched), genres, and year range. Results stay in
Foreseerr so you can play, inspect, or manage a title without leaving the app.
The [media management panel](media-management.md) provides release comparison
and manual import for mapped Radarr and Sonarr titles.

Titles load as you scroll, and **Load more titles** provides the same action
for keyboard navigation. It moves focus to the first newly loaded title. The
count below the grid shows how much of the catalog is loaded. If another page
fails, loaded titles remain usable and **Retry** resumes loading.

Watch status is available directly in the toolbar. Active genre, year, and
watch-status filters appear as removable chips. **Clear filters** keeps your
search and movie/series selection; the reset action on an empty result clears
both the search and filters. The filter panel updates results as you choose
and keeps **Show titles** visible while you scroll. Watch status and genres
update immediately. Enter complete four-digit years, then choose **Apply year
range**, or use **Show results** to apply the range and close the panel. A
reversed range stays editable with an explanation. **Clear filters** also
clears any year range you are still typing.

## Skipped episode endings

Under **User Settings → General**, you can enable **Auto-complete skipped
episode endings**. When you have started a later episode, leftover paused
episodes at or above the minimum progress are marked watched in Jellyfin and
Trakt the next time Library loads. Simkl is not part of that cleanup.

This is off by default.

## Requests

Library does not request missing titles. Use [Discover](discover.md) for that.
The calendar still lists upcoming Radarr/Sonarr dates for titles you already
requested.

For long series, open **Request options → Watch Ahead** on the series detail
page to keep a buffer of unwatched episodes requested as you watch in Jellyfin.
You can also switch to **Watch Ahead** inside the TV request modal. Choose a
quick buffer of 5, 10, or 20 episodes, or enter any number from 1 to 50.
The dialog links to your default buffer in General settings. This is opt-in
per title and requires episode requests to be enabled.

In **Episodes**, choose a season and search by episode name or number. Select
the first episode, then **Add More Episodes** to choose the end of a range, or
**Include Future Episodes** to keep requesting new episodes from that point.
