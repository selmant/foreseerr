# Foreseerr Product Direction and Recommendation Research

Research snapshot: 2026-08-01

This document preserves the product ideas, third-party recommendation research,
and proposed roadmap discussed while planning Foreseerr's direction. Provider
capabilities, limits, pricing, and terms can change, so verify them before
implementation.

## Product identity

Foreseerr should become more than a Seerr fork with additional integrations.
Its clearest identity is:

> Foreseerr helps every household member decide what to watch next and request
> it immediately.

Seerr already handles requests, approvals, Radarr/Sonarr routing, and media
server availability well. Foreseerr's differentiator should be the complete
path from personal taste to a confident decision:

1. Learn what each user enjoys.
2. Combine recommendations from multiple sources.
3. Explain why each title was recommended.
4. Remove watched, available, blocked, dismissed, and unsuitable results.
5. Let the user watch an available title or request a missing title immediately.

The strongest release message would be:

> Open Foreseerr and immediately see relevant unwatched titles selected for
> you, rather than another generic trending carousel.

## Flagship experiences

### Personalized For You feed

Build a personal feed from:

- Jellyfin, Plex, or Emby viewing history
- Trakt history, ratings, recommendations, lists, and watchlist
- MDBList ratings and personalized lists
- Titles previously requested, dismissed, rejected, or completed
- Favourite genres, people, studios, networks, languages, and formats
- Existing media-server availability
- Explicit Foreseerr feedback

Every recommendation should have an explanation, for example:

- Because you rated *Severance* 9/10
- Recommended by both Trakt and MDBList
- From a director you frequently enjoy
- A hidden gem in one of your favourite genres
- New season of a show you completed
- Popular with users who liked several of your favourites

This does not require an LLM. A transparent weighted scoring model can be
private, inexpensive, deterministic, and easy to tune.

### Watch Something Now

Create a feed containing only titles already available to the current user on
their media server. Possible rows include:

- Suggested for you from your Jellyfin library
- Recently added and relevant to you
- Forgotten requests
- Short movies for tonight
- Continue a genre, director, or studio you recently enjoyed
- Highly rated titles in the library that you have not watched

**Shipped baseline (Foreseer `/library`):** Continue Watching and Recently Added
via user-linked Jellyfin APIs, Ready to Watch from the user's available
requests, plus available browse/search. Cards play through desktop `playItem`
or Jellyfin deep links. Personalized scoring and household Watch Tonight remain
later phases.

The product should distinguish clearly between:

- **Watch now:** already available locally
- **Discover next:** unavailable but requestable

### What Should We Watch Tonight?

Create a decision-focused household mode:

1. Select participating users.
2. Select movie or show, maximum runtime, genre, mood, and release period.
3. Choose available-now or requestable results.
4. Exclude titles watched or rejected by any participant.
5. Rank titles by shared compatibility.
6. Present a small number of strong candidates.
7. Let participants swipe, vote, veto, or accept.
8. Play or request the winner.

This is a particularly strong differentiator because request managers and
individual tracking services generally do not solve household selection.

### Smart list intake

Turn Trakt and MDBList lists into safe workflows instead of passive pages:

- Preview list matches before requesting anything.
- Separate available, watched, requested, blocked, unmapped, and new titles.
- Bulk-select entries for manual requests.
- Pin a list as a Discover row.
- Subscribe to list changes without enabling automatic requests.
- Optionally place new items in an approval queue.
- Impose per-refresh and per-period request limits.
- Support dry runs.
- Explain which Radarr/Sonarr instance and profile each item will use.
- Record which list caused a request.

## Recommendation provider research

Foreseerr should aggregate providers behind one internal contract rather than
make users choose one global recommendation provider.

| Provider | Personalized | Cost/limit snapshot | Recommended use |
| --- | --- | --- | --- |
| Trakt | Yes | Existing integration; API policy can change | Primary personal source |
| MDBList | Yes, through personalized lists | Free API key: 1,000 requests/day | Best immediate addition |
| Couchmoney | Yes | Free; produces Trakt lists | Consume through existing Trakt list support |
| Jellyfin Suggestions | Partially, within the library | Free and local | Watch-now recommendations |
| Recombee | Yes | Free plan with catalog, user, and request limits | Optional hosted ranking engine |
| TMDB | No; title-to-title | Free for attributed non-commercial use | Candidate generation and metadata |
| AniList | Community title-to-title | Free with usage restrictions | Anime history and candidates |
| Jikan | Community title-to-title | Free, unofficial, read-only MAL scraper | Anime candidate fallback |
| Watchmode | Related titles and availability | 2,500 free requests/month, non-commercial | Cached availability enrichment |
| Simkl | Yes in its own product | Personal recommendations require PRO/VIP | History source; not a default recommender |
| Letterboxd | Potentially | API access is selective | Do not depend on it |
| Qloo | Yes | Sales-led and no clear durable free plan | Avoid initially |
| TasteDive | Similarity-focused | Current access and terms unclear | Avoid initially |

### MDBList

**Shipped:** public-list pinning as custom Discover sliders, plus the existing
rating badges/filters, using the instance API key.

MDBList is likely the lowest-cost new source because Foreseerr already has an
API key setting, health checks, ratings, TMDB identity handling, and list-like
interfaces. MDBList recently exposed personalized recommendation lists as
filter sources and has expanded its public API for applications.

Potential integration:

- Recommended by MDBList rows
- Separate movie and show feeds
- Preserve upstream ordering/confidence
- Hidden-gem and popularity controls
- Source attribution on every result
- Per-user caching and manual refresh
- Exclude watched, available, requested, blocked, and dismissed titles

Prototype the exact personalized-list discovery flow before promising support.

Sources:

- [MDBList API documentation and limits](https://docs.mdblist.com/docs/api)
- [MDBList recent API changes](https://mdblist.com/new-features/)
- [MDBList list types](https://docs.mdblist.com/docs/list_types)

### Couchmoney

Couchmoney generates personalized movie and TV recommendations from a user's
Trakt ratings. It creates automatically updated lists in that user's Trakt
account. It has no public recommendation API, but Foreseerr can consume the
resulting lists using its authenticated Trakt-list support.

Potential integration is mostly UX:

- Couchmoney setup instructions
- Pin any Couchmoney list to Discover
- Display a Couchmoney source badge
- Preserve list order because it represents confidence
- Refresh through the existing Trakt list flow
- Avoid brittle name-based detection; allow users to designate a list source

Source: [Couchmoney](https://couchmoney.tv/)

### Jellyfin Suggestions

Jellyfin exposes `GET /Items/Suggestions` and similar-item endpoints. Results
are limited to the local library, which makes them suitable for Watch Something
Now rather than acquisition recommendations.

Potential integration:

- Per-user local suggestions
- Recently played context
- Similar available titles
- No external account or data sharing
- Direct links into Jellyfin where possible

Source: [Jellyfin API endpoint reference](https://github.com/sj14/jellyfin-go/blob/main/api/README.md)

### Recombee

Recombee is the strongest ready-made external recommendation engine found with
a meaningful free plan. At the time of research, its free plan allowed up to
20,000 catalog items, 20,000 active users, and 100,000 recommendation requests
per month.

Candidate events include:

- watched
- rated
- requested
- dismissed
- opened details
- added to watchlist
- completed series
- abandoned series

Advantages:

- Real-time personalized ranking
- Less ML infrastructure for Foreseerr to operate
- Adequate limits for typical homelabs
- Can combine multiple event types

Disadvantages:

- User activity leaves the self-hosted environment.
- Users need another service and API key.
- The entire TMDB catalog exceeds the free item limit.
- The product becomes partially dependent on a SaaS.

If added, make it strictly optional, use opaque user identifiers, send the
smallest possible data set, document privacy implications, and keep a local
fallback.

Sources:

- [Recombee pricing](https://www.recombee.com/pricing)
- [Recombee free-plan limits](https://www.recombee.com/faq)

### TMDB

TMDB provides movie and TV recommendation and similar-title endpoints. These
are not personalized, but they are useful candidate generators.

Suggested method:

1. Select titles a user rated highly or completed recently.
2. Fetch related candidates for each seed.
3. Increase a candidate's score when several seeds point to it.
4. Apply the user's genre, language, year, and runtime preferences.
5. Filter watched, available, blocked, requested, and dismissed titles.
6. Diversify the final page.

Sources:

- [TMDB movie recommendations](https://developer.themoviedb.org/reference/movie-recommendations)
- [TMDB API terms](https://www.themoviedb.org/api-terms-of-use)
- [TMDB API FAQ](https://developer.themoviedb.org/docs/faq)

### AniList, MyAnimeList, and Jikan

**Shipped:** AniList catalog Discover rows (trending, this season, popular, top
100, next season), linked watching/planning/completed and named lists, TMDB
mapping, and optional watched/score sync. Personalized AniList-to-AniList
recommendation ranking is still future work.

AniList exposes community-created title-to-title recommendations, not a
ready-made personalized recommendation feed. Its personal history, scores,
favourites, genres, and list state are useful inputs for Foreseerr's own anime
ranking. AniList's terms restrict competing tracker services, so review the
integration and request authorization if necessary.

Jikan exposes MyAnimeList recommendation relationships, but is an unofficial,
read-only scraper. It should be treated as a candidate fallback rather than a
critical dependency.

Sources:

- [AniList Recommendation object](https://docs.anilist.co/reference/object/recommendation)
- [AniList API](https://anilist.gitbook.io/anilist-apiv2-docs)
- [AniList terms](https://anilist.gitbook.io/anilist-apiv2-docs/docs/guide/terms-of-use)
- [Jikan API](https://docs.api.jikan.moe/)

### Simkl

Simkl provides personalized movie, show, and anime recommendations in its own
product, but the feature currently requires PRO or VIP. A documented public
endpoint returning those personal recommendation results was not confirmed.
Its public history and list APIs remain useful as future taste inputs.

Source: [Simkl personalized recommendations](https://docs.simkl.org/how-to-use-simkl/core-features/search-and-discovery/recommendations)

### Watchmode

Watchmode provides related titles and streaming availability. The free plan
currently offers 2,500 monthly requests for non-commercial use and requires
attribution. The limit is too small for uncached home-page ranking but may be
enough for cached availability enrichment.

Sources:

- [Watchmode API and pricing](https://api.watchmode.com/)
- [Watchmode API explorer](https://api.watchmode.com/docs)

### Letterboxd

Letterboxd's API is selectively granted. Its access page says it is not
currently granting access for several categories relevant to Foreseerr,
including many personal and recommendation projects. Do not make it a roadmap
dependency. Import/export or user-provided list URLs could be investigated
separately without scraping.

Source: [Letterboxd API access](https://letterboxd.com/api-beta/access/)

## Self-hosted recommendation engines

### `implicit`

[`implicit`](https://github.com/benfred/implicit) is the most practical
open-source engine identified. It is MIT-licensed and provides:

- Alternating Least Squares
- Bayesian Personalized Ranking
- Logistic matrix factorization
- Item-to-item cosine, TF-IDF, and BM25 models
- CPU and optional GPU training

The main limitation is data volume. A single household has too few users for
strong collaborative filtering. Foreseerr would need external candidates,
content metadata, or a larger opt-in community data set.

### LightFM

[LightFM](https://github.com/lyst/lightfm) supports implicit and explicit
feedback plus user/item metadata, making it useful for cold-start experiments.
Its latest published release visible during research was from 2023, so assess
maintenance and packaging risk before adopting it.

### RecBole

[RecBole](https://recbole.io/docs/) includes many general, sequential,
context-aware, and knowledge-based algorithms. It is better suited to research
and model evaluation than an initial production sidecar.

### LensKit

[LensKit](https://lenskit.org/latest/) is actively documented and useful for
experimentation, evaluation, and comparing ranking approaches. It is more
valuable for offline research than as Foreseerr's first embedded engine.

### Recommended local approach

Do not begin with a complex ML service. Start with a transparent weighted
ranker:

1. Generate candidates from Trakt, MDBList, Couchmoney, TMDB, and anime sources.
2. Normalize provider scores and ranks.
3. Add agreement bonuses when providers select the same title.
4. Add preference bonuses from ratings and history.
5. Apply negative feedback and hard exclusions.
6. Apply diversity, novelty, and popularity controls.
7. Record impressions and outcomes for later model evaluation.

Once Foreseerr has enough interaction data, compare the baseline with
`implicit`, LightFM, or an optional Recombee backend.

## Provider-neutral architecture

Use a small internal candidate contract:

```ts
interface RecommendationCandidate {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  source:
    | 'trakt'
    | 'mdblist'
    | 'couchmoney'
    | 'jellyfin'
    | 'tmdb'
    | 'anilist'
    | 'jikan'
    | 'recombee';
  sourceScore?: number;
  reasons: RecommendationReason[];
}
```

Common pipeline:

```text
Recommendation providers
        ↓
Identity resolution to TMDB
        ↓
Deduplication and provider-agreement scoring
        ↓
Watched / available / requested / blocked filtering
        ↓
Personal preference ranking
        ↓
Diversity, novelty, and popularity adjustment
        ↓
Explainable Discover rows
```

Important implementation principles:

- Connect multiple providers simultaneously.
- Do not conflate configured, reachable, authenticated, and actively selected.
- Cache per user and per provider.
- Preserve provenance and upstream ordering.
- Make every cloud provider optional.
- Never export viewing history without explicit informed consent.
- Support provider failure without breaking the whole Discover page.
- Store recommendation impressions and feedback separately from provider data.
- Make dismissal reversible unless a user explicitly blocks a title.

## Feature backlog

### Personal recommendation controls

- Toggle individual recommendation sources.
- Weight sources, such as Trakt 50%, MDBList 30%, and local history 20%.
- More like this.
- Less like this.
- Not interested.
- Already watched.
- Do not recommend this genre, person, studio, network, or franchise.
- Temporary snooze instead of permanent dismissal.
- Reset taste profile.
- Recommendation history.
- Explanation for every result.
- Novelty control from safe choices to hidden gems.
- Popularity control from mainstream to obscure.
- Release-year preferences.
- Runtime preferences.
- Original-language preferences.
- Movie/show balance.
- Separate weekday and weekend preferences.
- Avoid unfinished or cancelled series.
- Prefer completed limited series.
- Hide adult content independently from request permissions.

### Taste onboarding

- Select favourite genres.
- Pick favourite movies and shows from a poster grid.
- Rate 10-20 recognizable titles.
- Select disliked genres and content types.
- Choose languages and subtitle/dub preferences.
- Choose preferred runtimes and release periods.
- Import Trakt, Jellyfin, AniList, MAL, or Simkl history.
- Show a taste-profile preview before finishing.
- Explain how recommendation data will be used.
- Allow onboarding to be skipped and resumed.

### Group and household features

- Match percentage across selected users.
- Shared recommendations.
- Household voting.
- Anonymous voting.
- Veto and never-show-again controls.
- Parental-rating intersection.
- Shared household watchlist.
- Notify all interested users when a title becomes available.
- Recommend from the intersection of users' tastes.
- Temporary party links for guests.
- Weighted random Pick for Us action.
- Separate adult and child group profiles.
- Remember recurring groups, such as family or friends.

### Discovery collections

- Hidden gems for you.
- Highly rated but unpopular.
- Because you rated a specific title highly.
- From directors you frequently enjoy.
- New from favourite studios or networks.
- Unwatched franchise entries.
- Complete the collection.
- Short movies for tonight.
- Limited series for the weekend.
- New seasons of completed shows.
- Critically acclaimed but unseen.
- Divisive titles you may personally enjoy.
- Recently added and relevant to you.
- Leaving a configured streaming service soon.
- Upcoming releases matching your taste.
- Recommendations based on friends' ratings.
- Award winners matching your preferences.
- Seasonal or holiday rows that still respect taste.
- Great first seasons with manageable episode counts.
- One-season shows before committing to a long series.

### Smart list workflows

- Pin any Trakt or MDBList list to Discover.
- Subscribe without auto-requesting.
- Preview additions and removals.
- Show changes since the previous refresh.
- Bulk-select and request.
- Configure list-specific request profiles.
- Limit requests per refresh or time period.
- Place subscribed-list additions in an approval queue.
- Ignore watched and available titles automatically.
- Pause and resume subscriptions.
- Notify when a list gains relevant titles.
- Record the source list on each request.
- Merge several lists into one row.
- Intersect lists.
- Create difference lists, such as recommended but unavailable.
- Calculate list trust from how users rate prior recommendations.
- Preserve upstream order where it carries confidence.
- Dry-run list changes before applying them.
- Require a minimum rating or provider-agreement score.

### Request improvements

- Custom request profiles beyond Standard and 4K.
- Per-profile language, quality, root folder, tags, and service instance.
- Dedicated anime profiles.
- Request whole franchises or selected franchise entries.
- Request only future seasons.
- Limit the initial number of seasons.
- Request the first season as a trial.
- Upgrade an available title from 1080p to 4K.
- Vote before a request reaches an administrator.
- Require a household-demand threshold.
- Schedule requests near release dates.
- Show a request timeline with clear failure reasons.
- Offer safe automatic retry.
- Estimate storage and episode count before approval.
- Warn about ended, cancelled, or extremely long shows.
- Decline with a reason or comment.
- Let users withdraw their own pending requests.
- Notify every user interested in the same title.
- Allow request profile selection only where permitted.
- Make routing decisions visible before submission.
- Support separate availability by language/profile instead of treating any
  copy as fulfillment.

Relevant community requests:

- [Custom request profiles](https://github.com/seerr-team/seerr/issues/1737)
- [Future-seasons-only requests](https://github.com/seerr-team/seerr/issues/332)
- [New-episode notifications](https://github.com/seerr-team/seerr/issues/480)
- [Notify multiple interested users](https://github.com/seerr-team/seerr/issues/375)
- [Advanced request tag/path/profile permissions](https://github.com/seerr-team/seerr/issues/2248)
- [Limit seasons per request](https://github.com/seerr-team/seerr/issues/1351)

### Anime features

- Separate Anime navigation and discovery mode.
- AniList or MAL history import.
- Anime-specific candidate providers.
- Season-to-title and cour mapping.
- Absolute episode numbering.
- Sub/dub preference.
- Dedicated Sonarr instance and profile.
- Separate anime movies from ordinary movie discovery.
- Seasonal anime calendar.
- Follow studios, franchises, or source material.
- Continue completed franchises.
- Filter recaps, specials, OVAs, and compilation movies.
- Show adaptation and source-material status.
- Import community recommendations from AniList or Jikan.
- Anime-specific ratings and popularity signals.
- Detect mismatches between TMDB, TVDB, AniList, and MAL identities.

Relevant community requests:

- [Separate Anime mode](https://github.com/seerr-team/seerr/issues/2301)
- [Dedicated Sonarr/Radarr instances for anime](https://github.com/seerr-team/seerr/issues/232)

### Library intelligence

- Personal Watch Now shelves from Jellyfin.
- Forgotten requests.
- Requested by me.
- Recently fulfilled but unwatched.
- Most requested but least watched.
- Large titles with no playback.
- Duplicate-quality detection.
- Series with missing episodes.
- Failed request/import reconciliation.
- Library health dashboard.
- Jellystat or Tautulli playback context.
- Optional administrator cleanup candidates.
- Push personalized playlists into the media server.
- Mark fulfilled requests as user favourites.
- Per-user request-to-play conversion statistics.
- Show whether a recommendation is available to the current user, not merely
  present in some library.
- Surface titles that are available but hidden by library permissions.

Relevant community request:

- [Playback Reporting/Jellystat context](https://github.com/seerr-team/seerr/issues/981)

### Calendar and notifications

- Unified Sonarr/Radarr release calendar.
- Upcoming requested titles.
- New-season notifications.
- Weekly personal recommendation digest.
- Request available notification with a direct media-server link.
- Notify when a recommendation enters the library.
- Digest mode instead of one event per notification.
- Notify on subscribed-list changes.
- Release-date changes and delays.
- Per-user quiet hours.
- Notify users sharing interest in a title.
- Follow a show without requesting all future seasons.
- Calendar filtering by user, service, profile, or media type.

Relevant community requests:

- [Release calendar](https://github.com/seerr-team/seerr/issues/672)
- [Newsletter](https://github.com/seerr-team/seerr/issues/167)
- [New-episode notifications](https://github.com/seerr-team/seerr/issues/480)

### Parental and household administration

- Per-user certification limits.
- Genre, keyword, studio, and original-language restrictions.
- Separate browse and request restrictions.
- Household profiles for children and guests.
- Require approval for content outside a profile's normal rules.
- Explain why a title is hidden or cannot be requested.
- Time-based access rules where appropriate.
- Ensure recommendation sources cannot bypass content restrictions.

Relevant community request:

- [Adjustable age restrictions per user](https://github.com/seerr-team/seerr/issues/501)

### Adoption, usability, and reliability

- TV and D-pad navigation.
- Installable PWA.
- Excellent mobile poster interactions.
- Accessible forms, dialogs, focus states, and screen-reader labels.
- Configuration backup and restore.
- Integration diagnostics with actionable fixes.
- Guided onboarding.
- Demo screenshots and an optional hosted demo.
- Stable migration from Seerr.
- Provider-neutral public APIs.
- Public roadmap and community voting.
- Clear privacy controls.
- Export and delete personal recommendation data.
- No mandatory cloud service.
- Integration status that distinguishes configured, reachable, authenticated,
  and ready per user.
- Graceful provider degradation.
- Cache observability and manual refresh controls.
- Easy import/export of Discover layout and provider preferences.
- Release notes focused on user outcomes.

Relevant community requests:

- [TV/D-pad navigation](https://github.com/seerr-team/seerr/issues/601)
- [Multiple notification-agent instances](https://github.com/seerr-team/seerr/issues/804)
- [Granular custom filtering](https://github.com/seerr-team/seerr/issues/2079)
- [Fallback display language](https://github.com/seerr-team/seerr/issues/1783)

### Large scope expansions to approach cautiously

These are popular but could dilute Foreseerr's identity and greatly increase
upstream merge and maintenance cost:

- Music/audio request management
- Books and Readarr/Bookshelf support
- Multiple media servers of the same type
- Full social network functionality
- General-purpose LLM chat
- Hosting a global collaborative-rating data set

Music and books have visible community demand, but they would make Foreseerr a
broader request manager instead of a better discovery-to-request product.

Relevant community requests:

- [Music/audio support](https://github.com/seerr-team/seerr/issues/96)
- [Bookshelf support](https://github.com/seerr-team/seerr/issues/134)

## Measurement and evaluation

Recommendation work needs measurable outcomes. Record privacy-conscious events
such as:

- recommendation impression
- details opened
- dismissed
- more-like-this selected
- watchlisted
- requested
- request fulfilled
- played after fulfillment
- rated after watching

Useful metrics:

- Recommendation click-through rate
- Request rate from recommendations
- Watch rate after fulfillment
- Dismissal rate
- Repeat recommendation rate
- Provider contribution and agreement
- Diversity across genres, years, languages, and popularity
- Catalog coverage
- Time from opening a session to making a decision
- Group-session completion rate

Always allow administrators to disable analytics collection and users to
delete their personal feedback history.

## Recommended delivery roadmap

### Phase 1: foundation and quick provider wins

1. Define the provider-neutral recommendation candidate contract.
2. Normalize, deduplicate, filter, rank, and explain candidates.
3. Add MDBList personalized-list discovery after validating the API flow.
4. Add pinning for Couchmoney and other authenticated Trakt lists.
5. Add Jellyfin-powered Watch Something Now. **In progress:** Foreseer `/library` ships Continue Watching, Recently Added, Ready to Watch (available requests), and available browse/search; play uses existing desktop `playItem` / Jellyfin links.
6. Add per-provider readiness, caching, and manual refresh.

### Phase 2: user feedback and explainability

1. Add More like this, Less like this, Not interested, and Already watched.
2. Add recommendation history and reversible dismissals.
3. Add source weights and novelty/popularity controls.
4. Add taste onboarding for users with little history.
5. Add weekly personalized digests.
6. Measure recommendation-to-request and fulfillment-to-play conversion.

### Phase 3: household differentiation

1. Build What Should We Watch Tonight?
2. Add recurring groups, compatibility scores, voting, and vetoes.
3. Add shared watchlists and interested-user notifications.
4. Add parental-rating intersection and guest sessions.

### Phase 4: safe automation and advanced requests

1. Add list subscriptions with preview and approval queues.
2. Add limits, dry runs, source tracking, and list-specific profiles.
3. Add custom multilingual and quality request profiles.
4. Improve request timelines, failure explanations, and retry.

### Phase 5: anime specialization

1. Add Anime mode and dedicated service routing.
2. Import AniList or MAL history with terms-compliant behavior.
3. Add anime identity mapping and seasonal discovery.
4. Add sub/dub and recap/special filtering.
5. Rank anime candidates locally from personal history and community links.

### Phase 6: recommendation-engine experiments

1. Preserve the transparent weighted ranker as the baseline.
2. Experiment with optional Recombee using anonymized minimal data.
3. Evaluate `implicit` or LightFM offline after sufficient feedback exists.
4. Compare models using ranking, diversity, coverage, and conversion metrics.
5. Never require an external recommender for core Foreseerr operation.

## Recommended immediate next work

The best near-term implementation sequence is:

1. Recommendation provider interface
2. MDBList recommendation rows
3. Couchmoney/Trakt list pinning
4. Jellyfin Watch Now page
5. Feedback actions and explanations
6. Weekly recommendation digest
7. Household Watch Tonight mode
8. Optional Recombee experiment
9. Anime mode and AniList history
10. Self-hosted model only after enough interaction data exists

