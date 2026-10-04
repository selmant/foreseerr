---
title: Watch tracking
description: Understand watch status and ratings across connected services.
---

# Watch tracking

Open **Watch tracking** from a movie or series page, or from a Library title
panel. It shows the current title and each service’s saved watch status and
rating. **Refresh status** checks the enabled services again. **Linked accounts
& tracking** opens the account settings where you can connect services and
choose which ones participate in watch tracking.

The panel summarizes how many enabled services loaded this title. Each service
shows whether its status loaded, the title was not matched, or the service was
unavailable, along with whether it supports watch status, ratings, or both.
Inactive services remain accessible under **Other services**. When services
disagree about watch status, the panel highlights the difference and explains
how Foreseerr combines their saved values. A failed refresh keeps those values
visible while you retry.

Foreseerr shows a title as watched when any available service reports it as
watched. A series can be watched on a tracker while Jellyfin still has
unwatched episodes; Library episode counts and playback progress come from
Jellyfin. The tracking panel shows these differences instead of hiding them.

**No matching title** means a service could not find this title in its catalog.
**Status unavailable** means the status could not be read; try refreshing.
Other available services can still be used. When no service is enabled, the
panel explains how to set one up.

Choose **Rate** to open the rating picker. Select a score from **1–10** and
press **Save rating** to update the enabled rating services. Selecting a score
only prepares a draft. **Cancel**, **Close rating**, or Escape leaves the saved
rating unchanged. If saving fails, the picker keeps the chosen score and shows
the error so you can try again.

The rating choices use one Tab stop. Arrow keys move between scores, and
**Home** and **End** select **1** and **10**. Tab moves from the score group
to the dialog actions. The save action keeps focus while it shows **Saving…**,
so the result or retry remains easy to reach.

Watch and rating controls apply to the enabled services that support the
action for this title. Individual episode controls are available in Library
and series details for supported services.
