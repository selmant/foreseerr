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
| `92bad10c` | Applied | Added optional comma-separated ntfy tags through settings, API schema, UI, and docs; the agent trims and omits empty tags before sending. Foreseerr uses the same ntfy integration, so the upstream change applies directly. |
| `a123d20b` | Applied | Send `Foreseerr/<version>` on outbound Axios calls, including shared API, Tautulli, and image clients; preserve explicit service-specific or caller-provided User-Agent headers. |
| `5af32cb2` | Skipped | Already implemented in Foreseerr `66693021`: both General and Network saves revalidate all `/api/v1/status` SWR keys, including the modal's `/api/v1/status?checkUpdateAvailable=false` key and the version-status variant. |
| `0be53e6e` | Applied | Keep person results when hide-available or hide-blocklisted is enabled in both discover pages and mixed sliders; continue filtering movie/TV statuses. Foreseerr's trending results include people, and its extra AniList, Simkl, and MDBList sources may also have items without a declared media type, which these settings should not discard. |
| `2759058a` | Applied | Adapted TMDB movie/TV sort lists and per-type query validation to Foreseerr's split Discover router; TV title sorting now uses `original_name`. Updated blocklisted-tag scans to use valid sort keys per media type and corrected page iteration, retaining Foreseerr's existing filtering and pagination. |
| `0f79ee66` | Applied | Adapted the test database guard so accidental seed/reset outside test mode fails before database access; the intentional Cypress prepare script opts in. Foreseerr already has generated explicit registration for its compiled binary (including 16 fork-specific entities), source globs exclude tests, and its server build excludes test files, so upstream's shorter hard-coded registry and build changes would regress fork coverage. |
| `cc592e8d` | Applied | Added 30 Catalan server notification translations and corrected the movie label casing. All keys match the English catalog and preserve its interpolation variables; the `{applicationTitle}` messages use Foreseerr's configured title. Corrected two obvious translation typos. |
| `da4b555c` | Applied | Removed `appear` from the Modal and SlideOver `Transition.Child` elements: Headless UI 1.7.19 forwards it to their DOM nodes. Parent `Transition` elements retain `appear` for entrance animations. |
| `d7b08bdd` | Applied | Moved the PostgreSQL flag into an import-free module so entity decorators resolve timestamp columns without a datasource import cycle. Foreseerr's lazy datasource and release-state code also use this flag, so their imports were adapted. |
| `1cc2f116` | Applied | Upgraded Headless UI from 1.7.19 to 2.2.10 in Foreseerr's Bun manifest and lockfile. React 19 now satisfies its declared peer range. Added explicit `div` transition wrappers in the seven affected UI components and fixed the Jellyfin link modal's opacity class typo; retained Foreseerr's existing transition and fork-specific components. |
| `df743f46` | Applied | Matched the shared SlideOver backdrop's exit fade to its panel's 500 ms / 700 ms slide-out. The Headless UI 2.2.10 transition remains mounted through the longer child animation; the previous 300 ms backdrop fade could flash during close. This applies to Foreseerr's library and Servarr panels as well as Seerr-derived panels. |
| `aa8e0de0` | Applied | Switched shared Headless UI menus, listboxes, transitions, disclosure, and labels to flat named exports after the 2.2.10 upgrade. Kept Foreseerr's click-only dropdown button, custom item styles, and TV season test hook through conflict resolution. Left `RadioGroup.Option` for the following upstream Radio refactor. |
| `46d5915d` | Applied | Replaced the issue modal's `RadioGroup.Option` with the Headless UI 2.2 `Radio` component and changed its focus indicator to use `focus`; Foreseerr retains the same issue-type selector and this was its only remaining `RadioGroup.Option` usage. |
| `7997f756` | Applied | Ignore scanner file counts for provider seasons with zero episodes, and compare the actual requestable season numbers in the TV page and modal so phantom specials cannot block requests. Adapted the TV page's coverage check to Foreseerr's episode requests: a processing season with an active partial episode request remains eligible for a full-season request. |
| `5f4cb1ea` | Applied | SQLite's latest push-subscription table still enforced `UNIQUE(auth)` despite the entity requiring only `UNIQUE(endpoint, userId)`. Added the upstream table rebuild, preserving rows, foreign key, and user index while removing the stale constraint; registered it for the compiled binary. |
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
