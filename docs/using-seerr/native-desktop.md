---
title: Desktop App
description: Use Foreseerr as a desktop app that plays Jellyfin media in its own window.
sidebar_position: 7
---

# Desktop App

The [Foreseerr desktop app](https://github.com/selmant/foreseerr-player)
shows your Foreseerr in a window of its own and plays Jellyfin media in that
same window. When you press Play, a full player with on-screen controls takes
over the window; when you stop, you are back in Foreseerr where you left it.

You don't need the app to use Foreseerr: in a browser, play buttons keep
opening Jellyfin as before.

The player is [Moonfin](https://github.com/Moonfin-Client/Moonfin-Core), the
open-source Jellyfin client, built into the app. The app is not made or
supported by the Moonfin team; report problems with it in the
[app's repository](https://github.com/selmant/foreseerr-player/issues).

## Requirements

- Linux (x64), with WebKitGTK 4.1 and libmpv from your distribution. Download
  the latest release from the
  [app's releases](https://github.com/selmant/foreseerr-player/releases),
  unpack it, and run `./install.sh` for a menu entry.
- A Foreseerr account linked to Jellyfin (Profile → Settings → Linked
  Accounts). Plex and Emby playback in the app is not supported yet.

On first start, the app asks for your Foreseerr address. Then sign in to
Foreseerr as usual; the app keeps you signed in.

## How playback works

- Press Play on a title in Foreseerr. The app plays it from where you left
  off.
- The first time you play, the app signs its player in to Jellyfin as you,
  using your linked Jellyfin account. There is no separate Jellyfin sign-in.
  Foreseerr hands the player a single-use ticket for this, valid for a short
  time.
- The player uses the same Jellyfin session as your Foreseerr link. Signing
  that session out in Jellyfin (Dashboard → Devices) signs out both; link
  Jellyfin again in Foreseerr and play once more.
- If someone else signs in to Foreseerr in the app and plays, the player
  switches to their Jellyfin user.
- Made fullscreen from the player, the window returns to windowed when you
  stop.

## Player settings

In the app, Profile → Settings → **Player** shows the player's own settings,
such as subtitles, audio and playback options. Change them and press
**Save Changes**. This page only appears inside the app.

## Troubleshooting

- **Play opens Jellyfin instead:** you are in a browser, not the app.
- **"Could not play" at the bottom of the page:** check that your Foreseerr
  account is linked to Jellyfin and that Jellyfin is reachable from this
  computer.
- **The app can't open Foreseerr:** it shows the error with Retry and Change
  address.

Don't share tokens, tickets, cookies or full private media URLs in bug
reports.

The earlier Foreseer Desktop companion (based on Jellium) is no longer
developed; its repository is archived. This app replaces it.
