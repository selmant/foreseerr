---
title: Foreseerr v0.16.0 release notes
---

## AI recommendations

- **AI Picks** recommends real movies, series and anime from a mood, a title
  you love, or your taste. Each pick has an explanation and feedback choices.
  Refine the results with suggested chips or your own words.
- Connect an OpenAI-compatible server endpoint, or let users connect their own
  ChatGPT account or endpoint. Personal ChatGPT connections use that person's
  plan and are never shared. Saved credentials are encrypted at rest.
- Add optional **SearXNG** web research alongside TMDB, AniList and Trakt.
  Docker Compose and Helm include private SearXNG deployment options.
- Feedback, requested picks, and later watches can build an editable taste
  card. Watch-history sharing is opt-in; watched-title exclusions happen on
  the server even without sharing history with the AI provider.
- Filter picks by movie, series or anime, and by whether they are in your
  library. Save completed requests as personalized Discover rows without
  generating them again.
- A nightly **AI Picks Refresh** job prepares rows and weekly picks for active
  users. Users can turn weekly picks off. Automatic generation uses provider
  resources and respects the server monthly budget, but does not consume a
  person's daily request allowance.
- Recent requests show posters, filters and outcomes, with individual deletion
  and clear-history controls. Retention defaults to 90 days. Discover row
  caching defaults to three days.
- Admins can inspect usage by person and model, failures, reported tokens and
  recommendation outcomes, and set daily request limits or a monthly server
  token budget.

See the [AI guide](using-seerr/settings/ai.md) for setup, privacy and limits.
AI features are disabled by default.

## Interface and documentation

- AI Picks lives in Discover's tabs. Explanation and feedback controls open
  from a lightbulb on each poster.
- Personal AI connections live in Linked Accounts. History and weekly-pick
  preferences use the Discover settings page's Save Changes and Discard flow.
- The README puts the Jellyfin plugin first, followed by the native desktop
  companion and AI features, with desktop and phone screenshots.

## Upgrade notes

- Upgrades from earlier stable Foreseerr releases, including `v0.15.1`, are
  supported on SQLite and PostgreSQL. Back up your configuration and database
  before upgrading; downgrades are not supported.
- Startup adds AI connection, preference, run, feedback, taste, pick and signal
  storage, plus indexes and revision fields. Existing media, requests and
  linked accounts are preserved.
- Back up the AI encryption key with the database. Foreseerr uses
  `FORESEERR_SECRET_KEY`, `FORESEERR_SECRET_KEY_FILE`, or a generated
  `secret.key` in the config directory. Replacing that key makes saved AI
  credentials unreadable.
- The existing Seerr API remains compatible; AI operations are additions.
- Images: `ghcr.io/selmant/foreseerr:v0.16.0` and
  `selmantr/foreseerr:v0.16.0`.
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart`, chart `0.16.0`,
  app `v0.16.0`.
- Server archives and Jellyfin-plugin runtimes are published for Linux x64,
  Linux arm64 and Windows x64, with `SHA256SUMS`.
