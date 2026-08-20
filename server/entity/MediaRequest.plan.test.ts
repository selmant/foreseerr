import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import EpisodeRequest from '@server/entity/EpisodeRequest';
import Media from '@server/entity/Media';
import {
  DuplicateMediaRequestError,
  MediaRequest,
  buildEpisodeRequestPlan,
  buildMovieRequestPlan,
  buildSeasonRequestPlan,
  materializeRequestPlan,
  type RequestPlanInput,
} from '@server/entity/MediaRequest';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import type { QuotaResponse } from '@server/interfaces/api/userInterfaces';
import type { ResolvedEpisodeSelection } from '@server/lib/episodeRequests';

const quotas: QuotaResponse = {
  movie: { used: 0, restricted: false },
  tv: { used: 0, restricted: false },
};

const actor = {
  id: 1,
  hasPermission: () => false,
};

const inputFor = (media: Media): RequestPlanInput => ({
  media,
  requestBody: {
    mediaId: media.tmdbId,
    mediaType: media.mediaType,
    is4k: false,
  },
  requestUser: actor as unknown as RequestPlanInput['requestUser'],
  actor: actor as unknown as RequestPlanInput['actor'],
  serverId: 3,
  profileId: 7,
  rootFolder: '/library',
  languageProfileId: 2,
  tags: [4],
  isAutoRequest: false,
  ignoreQuota: false,
});

const resolvedSelection = (
  type: ResolvedEpisodeSelection['type'] = 'range'
): ResolvedEpisodeSelection => ({
  type,
  startTvdbId: 101,
  ...(type === 'range' ? { endTvdbId: 202 } : {}),
  episodes: [
    { tvdbId: 101, seasonNumber: 1, episodeNumber: 1, title: 'One' },
    { tvdbId: 202, seasonNumber: 2, episodeNumber: 1, title: 'Two' },
  ],
  quotaUnits: 2,
});

describe('MediaRequest request plans', () => {
  it('creates a typed movie plan with only movie request fields', () => {
    const media = new Media({ tmdbId: 1010, mediaType: MediaType.MOVIE });
    const plan = buildMovieRequestPlan(inputFor(media));

    assert.equal(plan.kind, 'movie');
    assert.equal(plan.status, MediaRequestStatus.PENDING);
    assert.equal(plan.media, media);
    assert.equal(plan.rootFolder, '/library');
    assert.equal(plan.languageProfileId, 2);
  });

  it('filters covered episode selections before producing an episode plan', () => {
    const media = new Media({
      tmdbId: 2020,
      mediaType: MediaType.TV,
      status: MediaStatus.UNKNOWN,
      status4k: MediaStatus.UNKNOWN,
    });
    const covered = new MediaRequest({
      status: MediaRequestStatus.PENDING,
      is4k: false,
      seasons: [new SeasonRequest({ seasonNumber: 1 })],
      episodes: [],
    });

    const plan = buildEpisodeRequestPlan({
      input: inputFor(media),
      selection: resolvedSelection(),
      activeRequests: [covered],
      quotas,
    });

    assert.equal(plan.kind, 'episodes');
    if (plan.kind !== 'episodes') {
      throw new Error('Expected episode plan');
    }
    assert.deepEqual(
      plan.episodes.map((episode) => episode.tvdbId),
      [202]
    );
    assert.equal(plan.episodeSelection.type, 'range');
  });

  it('keeps active episode-request processing seasons eligible for full requests', () => {
    const media = new Media({
      tmdbId: 3030,
      mediaType: MediaType.TV,
      seasons: [
        new Season({ seasonNumber: 1, status: MediaStatus.PROCESSING }),
        new Season({ seasonNumber: 2, status: MediaStatus.AVAILABLE }),
      ],
      status: MediaStatus.UNKNOWN,
      status4k: MediaStatus.UNKNOWN,
    });
    media.requests = [
      new MediaRequest({
        status: MediaRequestStatus.PENDING,
        is4k: false,
        seasons: [],
        episodes: [new EpisodeRequest({ seasonNumber: 1, tvdbId: 1001 })],
      }),
    ];

    const plan = buildSeasonRequestPlan({
      input: inputFor(media),
      requestedSeasons: [1, 2, 3],
      quotas,
    });

    assert.equal(plan.kind, 'seasons');
    if (plan.kind !== 'seasons') {
      throw new Error('Expected season plan');
    }
    assert.deepEqual(plan.seasons, [1, 3]);
  });

  it('rejects a second active ongoing episode plan before persistence', () => {
    const media = new Media({ tmdbId: 4040, mediaType: MediaType.TV });
    const ongoing = new MediaRequest({
      status: MediaRequestStatus.APPROVED,
      is4k: false,
      episodeSelectionType: 'after',
      seasons: [],
      episodes: [],
    });

    assert.throws(
      () =>
        buildEpisodeRequestPlan({
          input: inputFor(media),
          selection: resolvedSelection('after'),
          activeRequests: [ongoing],
          quotas,
        }),
      DuplicateMediaRequestError
    );
  });

  it('materializes an ongoing plan with the constrained key and child statuses', () => {
    const media = new Media({ tmdbId: 5050, mediaType: MediaType.TV });
    const plan = buildEpisodeRequestPlan({
      input: inputFor(media),
      selection: resolvedSelection('after'),
      activeRequests: [],
      quotas,
    });
    const request = materializeRequestPlan(plan);

    assert.equal(request.ongoingEpisodeRequestKey, '5050:sd');
    assert.equal(request.episodeSelectionType, 'after');
    assert.equal(request.tvQuotaUnits, 2);
    assert.deepEqual(
      request.episodes.map((episode) => episode.status),
      [MediaRequestStatus.PENDING, MediaRequestStatus.PENDING]
    );
  });
});
