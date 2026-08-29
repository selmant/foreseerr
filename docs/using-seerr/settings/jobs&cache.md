---
title: Jobs & Cache
description: Configure jobs and cache settings.
sidebar_position: 6
---

# Jobs & Cache

Foreseerr performs certain maintenance tasks as regularly-scheduled jobs, but they can also be manually triggered on this page. Manually running a job does not change its schedule.

Jobs include media-server library scans, Radarr/Sonarr scans, availability and download sync, image-cache cleanup, blocklisted-tag processing, **Mapping Pack Refresh**, and **Mapping Gap Backfill**. Mapping job details are in [Mapping packs](../advanced/mapping-packs.md#jobs).

Foreseerr also caches requests to external API endpoints to optimize performance and avoid making unnecessary API calls. If necessary, the cache for any particular endpoint can be cleared by clicking the "Flush Cache" button.

You can also view the current image cache size as well as the total number of cached images. **Clear Browser HTTP Cache** is available only in Foreseer Desktop.
