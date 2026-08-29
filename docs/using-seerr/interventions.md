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
- **History** — releases Foreseerr already blocklisted.

Filter by Radarr vs Sonarr and movie vs series.

## Automatic cleanup

On **Settings → Integrations**, under Radarr/Sonarr, **Intervention cleanup**
can automatically reject overdue warnings after a grace period (hours). That
deletes the download, blocklists the release in Arr, and lets Arr retry.

Leave automatic cleanup off if you always want to choose import vs reject
yourself.

## Multi-instance note

Interactive Arr search, grab, queue, and import flows keep short-lived
operation state in the Foreseerr process. Run a single application instance,
or terminate TLS on a load balancer with sticky sessions, so start and poll
requests hit the same process. Restarts invalidate in-flight operations.
