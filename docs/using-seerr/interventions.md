---
title: Interventions
description: Review Radarr and Sonarr queue warnings from Foreseerr.
sidebar_position: 5
---

# Interventions

**Interventions** is an inbox for mapped Radarr/Sonarr queue warnings (failed
or blocked imports) and for imported Sonarr episodes that lack a required
audio or subtitle language. It is listed in the sidebar for users with the
Manage Requests permission.

## Active vs history

- **Active** — current warnings. Open one to **manual import** or **reject and
  blocklist** the release in Arr.
- **History** — releases Foreseerr already blocklisted or replaced, and files
  that were kept.

Filter by Radarr vs Sonarr and movie vs series. The view, filters, and page are
saved in the URL, so shared links and browser Back return to the same queue.

Each warning separates the service's explanation from the available next steps.
**Manual Import** opens that warning's own download and lists its files for
review, with the ready ones selected. It
appears when the service reports a completed download with a file location.
Otherwise, the row explains why import is unavailable. **Manage downloads** opens
the title's management panel to review its queue or find another release.

Use **Refresh** to check the queue immediately. Empty filtered results offer
**Clear filters**. Rejecting a release opens a confirmation showing the release
name, the affected service, and what will be deleted and blocklisted.

## Required languages

Each Sonarr server can require audio and subtitle languages in its settings
(**Required Audio Languages**, **Required Subtitle Languages**), with separate
lists for anime. For example, Japanese audio and English subtitles for anime
only. A file meets a list when it has at least one of its languages.

Sonarr can't see subtitles before a download, and it never refuses an import
over its tracks. So Foreseerr reads each imported file's tracks a few minutes
after Sonarr imports it. A file of a series Foreseerr manages that lacks a
required language shows up here, with what's missing and what the file has
("No English subtitles (subtitles: none)"). Then:

- **Replace** deletes the file and marks its import failed in Sonarr, which
  blocklists the release. It monitors the episode again, since Sonarr may
  unmonitor episodes whose file is deleted, and searches for it unless the
  server has automatic search off. A Watch Ahead episode waits for the new
  file.
- **Keep** leaves the file. It isn't flagged again.

Only subtitles inside the file count; Sonarr doesn't report separate `.srt`
files. A track that names no language could be any language, so a file with
one isn't flagged for that kind of track. Neither is a file Sonarr hasn't read
yet.

For audio, Sonarr can also refuse a release before downloading it: add a
**Language** custom format (for example "Original" for anime) to the quality
profile with a minimum custom format score. Foreseerr's check still catches
releases whose name doesn't say the language.

Replace and Keep aren't automatic, and automatic cleanup doesn't touch these
entries.

## Automatic cleanup

On **Settings → Integrations**, under Radarr/Sonarr, **Intervention cleanup**
can automatically reject overdue warnings after a grace period (hours). That
deletes the download, blocklists the release in Arr, and lets Arr retry.

Leave automatic cleanup off if you always want to choose import vs reject
yourself.

Administrators can see whether automatic cleanup is on from the Interventions
page and open **Cleanup settings** directly. Countdown labels explicitly describe
automatic rejection and appear only when automatic cleanup is known to be on.

## Multi-instance note

Interactive Arr search, grab, queue, and import flows keep short-lived
operation state in the Foreseerr process. Run a single application instance,
or terminate TLS on a load balancer with sticky sessions, so start and poll
requests hit the same process. Restarts invalidate in-flight operations.
