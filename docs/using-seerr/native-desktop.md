---
title: Native Desktop
description: Use Foreseerr through the optional Foreseer Desktop companion.
---

# Native Desktop

[Foreseer Desktop](https://github.com/selmant/foreseerr-desktop) is an optional
native shell for the hosted Foreseerr application. It is useful when you want
to browse Foreseerr normally and start supported Jellyfin playback in the same
desktop window.

Foreseerr itself remains the source of truth for sign-in, linked media-server
accounts, discovery, requests, library browsing, and playback fallback. You do
not need Foreseer Desktop to use Foreseerr in a browser.

## How it works

| Surface | Responsibility |
| --- | --- |
| Foreseerr | Hosted UI, authentication, linked Jellyfin identity, discovery, requests, and ordinary browser links. |
| Foreseer Desktop | Desktop window, native capability bridge, secure one-time session bootstrap, and product configuration. |
| Jellium runtime | CEF/mpv window and compositor lifecycle plus the generic native extension seam. |
| Jellyfin Web | Media resolution, resume position, stream selection, and playback reporting. |

When Foreseerr runs in a normal browser, its play controls remain ordinary
Jellyfin links. When the same page detects a compatible Foreseer Desktop
runtime, it may hand a supported Jellyfin item ID to the native app instead.
Unsupported providers, trailers, missing native capability, and desktop errors
all retain the browser fallback.

## Requirements

- Foreseer Desktop `0.3.0` (or later) for standalone mode, recovery, and
  LAN Jellyfin playback. See the
  [Desktop README](https://github.com/selmant/foreseerr-desktop#readme) for the
  current platform and packaging status.
- A linked Jellyfin account for native playback. Standalone mode starts a
  bundled Foreseerr on localhost and does not need a separate hosted instance.
  Remote mode still needs the HTTPS address of your existing Foreseerr
  deployment. Do not put Jellyfin tokens, device IDs, or administrative keys
  in the URL or desktop configuration.

Remote mode’s first session uses your normal Foreseerr browser session to
perform a short-lived, single-use bootstrap. The page never receives the
linked Jellyfin access token. Standalone mode owns its own local database
under the Desktop config directory; upgrades of the bundled Foreseerr version
create a timestamped backup first.

## Expected behavior

- Sign in through Foreseerr as usual. The desktop app does not introduce a
  second normal Jellyfin login screen.
- A supported Jellyfin play action stays in the current Foreseerr route while
  native playback starts. Back or stop returns to that same route.
- Logging out or switching Foreseerr accounts clears the private native session.
- If the desktop runtime is unavailable, incompatible, or not linked, use the
  normal browser playback link instead.

## Troubleshooting

- **Playback opens in the browser:** confirm that Foreseer Desktop is running,
  points at the same Foreseerr origin, and that the signed-in account is linked
  to Jellyfin.
- **Desktop reports unavailable playback:** continue with the browser link,
  then check the Desktop app's safe diagnostics and release notes. Do not share
  tokens, tickets, cookies, or full private media URLs in bug reports.
- **Foreseerr works but native playback does not:** this is an optional-client
  issue; requests, library browsing, and normal browser links should remain
  usable.

For installation, release pins, and native-runtime troubleshooting, use the
[Foreseer Desktop repository](https://github.com/selmant/foreseerr-desktop).
