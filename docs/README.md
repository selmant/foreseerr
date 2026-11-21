---
slug: /
sidebar_position: 1
---

# Introduction

Welcome to the Foreseerr Documentation.

**Foreseerr** is a free and open source software application for managing requests for your media library. It integrates with the media server of your choice: [Jellyfin](https://jellyfin.org), [Plex](https://plex.tv), and [Emby](https://emby.media/). In addition, it integrates with your existing services, such as **[Sonarr](https://sonarr.tv/)**, **[Radarr](https://radarr.video/)**.

## Optional Desktop App

Foreseerr is a complete web application. If you want Jellyfin playback in the
same window on a desktop computer, install the optional
[desktop app](https://github.com/selmant/foreseerr-player) (Linux). Its player
is [Moonfin](https://github.com/Moonfin-Client/Moonfin-Core)'s. Browsers keep
their normal Jellyfin links. See [Desktop App](using-seerr/native-desktop.md).

Optional: run Foreseerr **inside Jellyfin** with the third-party [sidecar plugin](using-seerr/jellyfin-plugin.md) (alpha).

## Features

- **Full Jellyfin/Emby/Plex integration**. Login and manage user access with Jellyfin/Emby/Plex.
- **Syncs to your Jellyfin/Emby/Plex library** to show what titles you already have.
- Supports Movies, Shows and Mixed Libraries.
- **Integrates with Sonarr and Radarr**, including override rules, a unified **release calendar**, and an **interventions** inbox for queue warnings.
- **Library / Watch Now** for Jellyfin-linked accounts: Continue Watching, Recently Added, Ready to Watch, and library browse.
- **Easy to use request system** allowing users to request individual seasons or movies in a friendly, clean UI.
- **Simple request management UI**. Don't dig through the app to approve recent requests.
- **Mobile-friendly design**, for when you need to approve requests on the go.
- Granular permission system.
- Localization into other languages.
- Support for **PostgreSQL** and **SQLite** databases.
- Support for various notification agents.
- Easily **Watchlist** or **Blocklist** media.
- **Discover** from TMDB plus optional Trakt, AniList, Simkl, and MDBList sources.
- **Mapping** from those sources onto TMDB, with packs, live resolvers, and a repair queue.
- Optional **desktop app** that plays Jellyfin media in the same window.
- More features to come!

## We need your help!

[Foreseerr](https://github.com/selmant/foreseerr) is an ambitious project developers/contributors poured a lot of work into, and we still have a lot more to do. Foreseerr is the result of a collaborative effort between the original Overseerr project and the Jellyseerr fork, created to deliver an excellent request management solution for Plex, Jellyfin and Emby users.

We value your feedback and support in identifying and fixing bugs to make Foreseerr even better. As an open-source project, we welcome contributions from everyone. Contribution includes building new features, patching bugs, translating the application, or even just writing documentation.

If you would like to contribute, please be sure to review our [contribution guidelines](https://github.com/selmant/foreseerr/blob/develop/CONTRIBUTING.md).
