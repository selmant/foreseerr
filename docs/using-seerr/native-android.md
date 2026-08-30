---
title: Native Android
description: Use Foreseerr through the optional Foreseer Android companion on TV and phones.
sidebar_position: 8
---

# Native Android

[Foreseer Android](https://github.com/selmant/foreseer-android) is an optional
native shell for the hosted Foreseerr application. It is useful when you want
to browse Foreseerr on Android TV (or later a phone) and start supported
Jellyfin playback in the same app.

Foreseerr itself remains the source of truth for sign-in, linked media-server
accounts, discovery, requests, library browsing, and playback fallback. You do
not need Foreseer Android to use Foreseerr in a browser.

## How it works

| Surface | Responsibility |
| --- | --- |
| Foreseerr | Hosted UI, authentication, linked Jellyfin identity, discovery, requests, and ordinary browser links. |
| Foreseer Android | Android window, WebView, native capability bridge, secure one-time session bootstrap, and product configuration. |
| Jellyfin Kotlin SDK | Media resolution, resume position, stream selection, and playback reporting. |
| Media3 / ExoPlayer | Decode and display video. |

This is the same product contract as [Native Desktop](native-desktop.md):
protocol v1 `play.item` with a Jellyfin item ID. It is **not** an embed of the
official Jellyfin Android TV app. Tokens stay in the native process; the
Foreseerr page never receives the linked Jellyfin access token.

When Foreseerr runs in a normal browser, play controls remain ordinary Jellyfin
links. When the same page detects a compatible Foreseer Android runtime, a
supported Jellyfin play action is handed to ExoPlayer instead.

## Requirements

- A sideloadable Foreseer Android APK (TV flavor first; mobile flavor shares
  the same player). See the
  [Android README](https://github.com/selmant/foreseer-android#readme).
- The HTTPS (or LAN HTTP) address of an existing Foreseerr deployment. Android
  does not bundle a Foreseerr server.
- A linked Jellyfin account for native playback.

## Expected behavior

- Sign in through Foreseerr as usual. The Android app does not introduce a
  second normal Jellyfin login screen.
- On Android TV, Library Watch Now posters are D-pad focusable. Select plays
  the resolved Jellyfin item in-app.
- Back or stop returns to the same Foreseerr route.
- Logging out or switching Foreseerr accounts clears the private native session.
- If the native runtime is unavailable, incompatible, or not linked, use the
  normal Jellyfin playback link instead (on TV this may require a browser).

## Troubleshooting

- **Playback does nothing / opens a browser:** confirm the app points at the
  same Foreseerr origin, that the signed-in account is linked to Jellyfin, and
  that the TV flavor injected `tv-focus`.
- **WebView is sluggish on a cheap stick:** use a Shield or Google TV 4K class
  device. System WebView quality varies widely on Android TV.
- **Foreseerr works but native playback does not:** this is an optional-client
  issue; requests, library browsing, and normal browser links should remain
  usable.
