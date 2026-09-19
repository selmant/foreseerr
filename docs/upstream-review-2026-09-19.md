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
| `d103787a` | Pending | fix(login): hide quick connect button for emby servers (#3369) |
| `39ff48c6` | Pending | test(cypress): stop dirty restartRequired flag cascading across specs (#3368) |
| `985ddef3` | Pending | fix(api): stop library reads from resetting enabled flags (#3321) |
| `c9f2ac58` | Pending | fix: keep library settings when renamed on media server (#3323) |
| `4d17e08b` | Pending | fix: stop masking connection failures across media server sync and login (#3324) |
| `059008cb` | Pending | fix(subscriber): keep request status updates on the owning save's connection (#3366) |
| `7fae95bb` | Pending | fix(override-rules): match default *arr server by id (#3428) |
| `92f84043` | Pending | fix(ui): don't mark empty collections as available (#3431) |
| `aae88167` | Pending | feat(users): add search box for user lookup by username or email (#2482) |
| `59ad5f19` | Pending | perf: bound tmdb cache & split scan lookups into their own tier (#3367) |
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
