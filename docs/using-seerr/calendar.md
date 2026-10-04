---
title: Calendar
description: Upcoming Radarr and Sonarr release dates in one place.
sidebar_position: 4
---

# Calendar

**Calendar** shows movie, season, and episode dates from the Radarr and Sonarr
servers configured under [Integrations](settings/integrations.md).

Switch between **Month** and **Agenda** on desktop or mobile. On phones,
Month shows a release count for each day; tap a day to open its release cards.
**Relevant to Me** and **All Monitored** are available directly on the page.
Open **Filters** for more choices:

- **Relevant to me** vs **All monitored**
- Movies vs series
- Source (Radarr / Sonarr)
- 4K-only

Use **Jump to date** and **Go** to open a particular date. Month arrows move
one month; Agenda arrows move 45 days. **Today** returns to the current date,
and the refresh button checks for updated releases. Agenda ranges show the year
so dates remain clear when planning across years.

The date, view, and filters are kept in the URL. Shared links and browser Back
restore the same period, including when you return from a title's details.

Filters update results immediately. Remove an individual filter from its chip,
use **Clear filters** to return to the default scope, or select **Show releases**
to close the filter panel.

Open an item for known dates, request a season, watch if it is already
available, or manage the title in Radarr/Sonarr. These actions stay visible at
the bottom of the details panel while you review its dates. Date-change badges (delayed,
moved earlier, withdrawn) appear when Arr reports them.

Calendar is not a Simkl or Trakt airing calendar. Those providers are not
ingested here.

If a source has not synced recently, Calendar may show a partial-results
warning. Confirm Radarr/Sonarr connectivity and the Radarr/Sonarr scan jobs
under [Jobs & Cache](settings/jobs&cache.md).
