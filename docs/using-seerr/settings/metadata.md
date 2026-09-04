---
title: Metadata Providers
description: Choose TMDB or TVDB for series and anime metadata.
sidebar_position: 8
---

# Metadata Providers

**Settings → Metadata Providers** selects which catalog Foreseerr uses for
series and for anime. Test connectivity before saving.

TMDB remains the canonical id space for Discover mapping and most Foreseerr
detail URLs. TVDB can be selected as the series or anime metadata provider
when you want Arr-oriented episode catalogs.

If a chosen provider fails the test, keep the working provider until the
outage or API key issue is fixed.

## Episode requests and Watch ahead

Partial series requests plus the TVDB provider also unlock episode picks
(single, range, or include-future) and **Watch ahead**. Watch ahead keeps a
rolling buffer of unwatched episodes requested from Jellyfin watch progress.
The default buffer size is in **User Settings → General**; each request can
override it.
