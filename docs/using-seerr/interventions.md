---
title: Interventions
description: Review Radarr and Sonarr queue warnings from Foreseerr.
sidebar_position: 5
---

# Interventions

**Interventions** is an inbox for mapped Radarr/Sonarr queue warnings (failed
or blocked imports). It is listed in the sidebar for users with the Manage
Requests permission.

## Active vs history

- **Active** — current warnings. Open one to **manual import** or **reject and
  blocklist** the release in Arr.
- **Blocklist history** — releases Foreseerr already blocklisted.

Filter by Radarr vs Sonarr and movie vs series. The view, filters, and page are
saved in the URL, so shared links and browser Back return to the same queue.

Each warning separates the service's explanation from the available next steps.
**Manual Import** lets you review downloaded files and their assignments. It
appears when the service reports a completed download with a file location.
Otherwise, the row explains why import is unavailable. **Manage downloads** opens
the title's management panel to review its queue or find another release.

Use **Refresh** to check the queue immediately. Empty filtered results offer
**Clear filters**. Rejecting a release opens a confirmation showing the release
name, the affected service, and what will be deleted and blocklisted.

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
