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
- **Ready to Watch** — available titles you have not started

Empty shelves are omitted. If nothing is linked, Library tells you to link
Jellyfin in settings. Playback uses the normal Jellyfin link in a browser, or
native playback when [Foreseer Desktop](native-desktop.md) is running.

Open a poster for series/season details, resume, next-unwatched, or rewatch
choices. Episode watched/unwatched toggles apply to Jellyfin (and to Trakt or
Simkl when those providers are enabled for the user).

## Browse

**Library → Browse** searches and filters the Jellyfin library: watch status
(unwatched, in progress, played), genres, and year range. Results stay in
Foreseerr so you can play, inspect, or manage a title without leaving the app.

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
