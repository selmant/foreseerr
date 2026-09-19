# Upstream review, 2026-09-19

Source: `seerr-team/seerr` `develop` at `59d5947b4df8591882bda70ae199f3a3480cc4da`.
Base: Foreseerr `github/develop` at `339bd9bb` (`v0.9.1`).
Each row records an individual review. Applied commits carry an `Upstream-Commit` trailer; skipped commits record why.

| Upstream commit | Decision | Foreseerr commit / reason |
| --- | --- | --- |
| `1fd35f9a` | Applied | `8b279581` — fix invalid alert nesting in TV request modal |
| `93c0b6a6` | Skipped | Already implemented: anime routing uses `isAnime` independent of `seriesType`; covered by existing test |
| `42bee2aa` | Skipped | Already implemented: `resolveSonarrSeriesRouting` uses configured `seriesType` for non-anime requests; covered by existing test |
| `7baed837` | Skipped | Already implemented verbatim in Foreseerr `4906d7aa`; scanner recognizes custom Plex provider GUIDs and resolves their external IDs |
| `090c659b` | Applied | Suppress verbose stdout from GHCR and Docker Hub Cosign attestation checks; Foreseerr runs both checks in its release job |
| `c8c8f7a1` | Skipped | Seerr-only release bump (`seerr-chart` 3.9.1 / app `v3.4.1`); Foreseerr's own chart is 0.9.1 / `v0.9.1`, tied to its package and image versions by the release workflow and version-consistency check. |
| `dea59605` | Applied | Adapted AI disclosure and security-report guidance to Foreseerr; kept the Bun build command and pointed the PR-label response at Foreseerr's own policy. |
| `afb17aa4` | Skipped | Already ported in Foreseerr `87058c58` (included in `4906d7aa`): Gotify settings toggle, Markdown poster image, `client::notification.bigImageUrl`, and English label are present; Gotify's default `embedPoster: false` and settings save path support the option. |
| `bd971f86` | Skipped | Node 22.23.2 Docker image pin does not apply: Foreseerr's production and local Dockerfiles use `oven/bun:1.4.1-alpine` for build and runtime, matching its Bun package scripts and lockfile. |
| `d3c070e1` | Skipped | Already ported in Foreseerr `dce92404`: Plex Web App URL tip names `https://app.plex.tv/desktop`, and the input suggests a server-hosted `/web/index.html` URL; both are present in the current UI and English locale. |
| `d103787a` | Applied | Behavior already ported in Foreseerr `4906d7aa`: both Emby UI buttons are hidden, all login and account-linking Quick Connect endpoints reject Emby, and new Quick Connect users are Jellyfin users. Adapted the remaining upstream account-linking regression tests; the three login endpoint guards already had tests. |
| `39ff48c6` | Skipped | Already ported verbatim in Foreseerr `4906d7aa`: the General Settings Cypress suite resets `trustProxy` through `/api/v1/settings/network` in `afterEach`, so a failed test cannot leave the restart-required state for later tests. |
| `985ddef3` | Applied | Plex and Jellyfin library GETs now only read settings; explicit PUT toggles a single library and POST sync refreshes the list, so opening settings no longer disables libraries. Adapted the import conflict with Foreseerr's mapping settings route. |
| `c9f2ac58` | Applied | Plex and Jellyfin library sync now match saved settings by stable server library ID, preserving the enabled flag across a rename while updating the display name; Jellyfin also retains the existing `lastScan` value. Fits Foreseerr's explicit sync flow introduced by `985ddef3`. |
| `4d17e08b` | Applied | Propagate Plex and Jellyfin connection failures through sync and login, retain Plex library settings when migration cannot reach its server, and show the setup connection error. Adapted startup and setup UI conflicts to Foreseerr's managed runtime and React Router; changed the Jellyfin toast to name Foreseerr. |
| `059008cb` | Applied | Adapted media subscriber request updates and nested status saves to use the owning TypeORM manager, retaining Foreseerr's episode request logic and existing transactional request lookups. SQLite keeps its shared manager; PostgreSQL uses a nested transaction. Added the PostgreSQL pool acquisition timeout and documented it. |
| `7fae95bb` | Applied | Override lookup now uses the configured Radarr/Sonarr server ID instead of its array index, and skips lookup when no default exists. Adapted six request tests for Foreseerr's request flow; movie and TV overrides work with non-index IDs and ID 0. |
| `92f84043` | Applied | Guard regular and 4K collection availability checks against empty `parts`; Foreseerr has the same `every()` logic and otherwise shows empty collections as available. |
| `aae88167` | Applied | Added a debounced user-list search adapted to Foreseerr's React Router pagination; its existing `q` API searches username, email, Plex username, and Jellyfin username. Preserved Foreseerr's media-server import controls. |
| `59ad5f19` | Applied | Adapted a 15-minute, 2,000-entry TMDB scan tier within Foreseerr's existing shared 256 MiB weighted LRU budget; scanner TV and external-ID lookups use narrow responses, while anime metadata provider fallback remains intact. Dropped the redundant Plex GUID cache, requested inline GUIDs for recent movies, and stripped unread TV credits. Kept Foreseerr's cache implementation and `node-cache` dependency (still used by the Servarr route). |
| `92bad10c` | Pending | feat(notifications): add support for ntfy.sh tags (#3350) |
| `a123d20b` | Pending | feat(api): send a Seerr user agent on outbound requests (#3395) |
| `5af32cb2` | Pending | fix(settings): mutate the query-string status key for modal immediately (#3432) |
| `0be53e6e` | Pending | fix: prevent hideAvailable/hideBlocklisted from filtering person results (#3434) |
| `2759058a` | Pending | fix(discover): fix tv title sorting and validate sortBy per media type (#3305) |
| `0f79ee66` | Pending | fix(datasource): register entities and subscribers explicitly (#3375) |
| `cc592e8d` | Pending | chore(i18n): update translations from Weblate |
| `da4b555c` | Pending | fix(ui): stop appear leaking onto the DOM in Modal and SlideOver (#3446) |
| `d7b08bdd` | Pending | fix(datasource): break import cycle mistyping postgres timestamps (#3449) |
| `1cc2f116` | Pending | chore(deps): upgrade @headlessui/react to 2.2.10  (#3450) |
| `df743f46` | Pending | fix(ui): stop the slideover backdrop flashing back on close (#3451) |
| `aa8e0de0` | Pending | refactor(ui): use headlessui flat named exports (#3453) |
| `46d5915d` | Pending | refactor(ui): use the Radio component instead of RadioGroup.Option (#3454) |
| `7997f756` | Pending | fix(tv): prevent phantom specials from blocking season request (#3351) |
| `5f4cb1ea` | Pending | fix(db): drop stale auth unique on sqlite push subscriptions (#3391) |
| `9f6403e1` | Pending | fix(requests): enforce pending and failed states on request routes (#3385) |
| `5a5f0590` | Pending | ci(actions): update github actions (#3306) |
| `5c04640b` | Pending | chore(i18n): update translations from Weblate |
| `e73825b2` | Pending | fix: fix empty discordId in comment webhooks (#3467) |
| `970bb545` | Pending | fix(requests): reset orphaned season statuses when a request is deleted (#3279) |
| `17fc4cc6` | Pending | fix(requests): stop editing a request from stealing another's season (#3376) |
| `d7dc7bdd` | Pending | fix(requests): serialize request creation per user (#3377) |
| `a4f5eaa2` | Pending | docs(docker): add cap-drop and security-opt to docker command (#3472) |
| `c604bccc` | Pending | fix(requests): scope download status to requested seasons on request cards (#3412) |
| `6bf3d048` | Pending | ci(actions): update github actions (major) (#3471) |
| `979978fc` | Pending | chore(deps): update database (#3458) |
| `a3dbbd94` | Pending | ci(actions): update github actions (#3478) |
| `5f972275` | Pending | chore(i18n): update translations from Weblate |
| `6f5a1773` | Pending | feat(settings): hide already requested media (#1855) |
| `68c5bc8c` | Pending | chore(i18n): update translations from Weblate |
| `1dbf19b8` | Pending | fix(requests): skip seasons with no episodes when requesting all seasons (#2698) |
| `4fc265b6` | Pending | docs(helm): fix documentation regarding chart signature verification (#3420) |
| `de57e7ac` | Pending | fix(jellyfin-api): update Authorization headers for Jellyfin (#3502) |
| `7a76142a` | Pending | test: add scanner update rate override for testing (#3241) |
| `a53f49bd` | Pending | fix(server): respond instead of hanging on proxy route errors (#3501) |
| `abe2f3bb` | Pending | test: block outbound HTTP in unit tests (#3511) |
| `d4eeea85` | Pending | fix(auth):  refresh avatar on Quick Connect login (#3504) |
| `b2116523` | Pending | refactor(avatarproxy): remove unused auth header from avatarproxy (#3503) |
| `34b28d0a` | Pending | fix(scanner): confirm orphan candidates against the servers before declining (#3399) |
| `2bebae83` | Pending | fix(db): remap leftover Overseerr DELETED status after migration (#3510) |
| `6fa7473d` | Pending | ci: remove third party action dawidd6/action-download-artifact (#3480) |
| `59d5947b` | Pending | fix(webpush): resolve push subscription bugs for multi-device and shared browsers (#3142) |
