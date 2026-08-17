import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import type ReleaseOccurrence from '@server/entity/ReleaseOccurrence';
import { In } from 'typeorm';

export type ReleaseRelevanceReason =
  | 'requested_movie'
  | 'requested_series'
  | 'requested_season'
  | 'requested_episode';

export interface ReleaseRelevance {
  userId: number;
  reason: ReleaseRelevanceReason;
  requestId: number;
  requestStatus: MediaRequestStatus;
}

/**
 * Centralizes the request-ownership rules used by the calendar and future
 * notification producers. It deliberately returns no requester identity.
 */
type RelevantOccurrence = Pick<
  ReleaseOccurrence,
  'id' | 'mediaId' | 'mediaType' | 'is4k' | 'seasonNumber' | 'tvdbId'
>;

export const getRequestRelevanceReason = (
  occurrence: RelevantOccurrence,
  request: MediaRequest
): ReleaseRelevanceReason | undefined => {
  if (
    request.status === MediaRequestStatus.DECLINED ||
    request.status === MediaRequestStatus.FAILED
  ) {
    return undefined;
  }
  if (occurrence.mediaType === MediaType.MOVIE) {
    return 'requested_movie';
  }
  if (
    occurrence.tvdbId &&
    request.episodes.some((episode) => episode.tvdbId === occurrence.tvdbId)
  ) {
    return 'requested_episode';
  }
  if (
    request.seasons.some(
      (season) => season.seasonNumber === occurrence.seasonNumber
    )
  ) {
    return 'requested_season';
  }
  if (request.episodeSelectionType || request.episodes.length > 0) {
    return undefined;
  }
  // A series request remains relevant to the user when a later season first
  // appears in Sonarr, even if that season was not automatically requested.
  return 'requested_series';
};

export async function getReleaseRelevanceMap(
  occurrences: RelevantOccurrence[]
): Promise<Map<number, ReleaseRelevance[]>> {
  const mediaIds = [
    ...new Set(
      occurrences
        .map((occurrence) => occurrence.mediaId)
        .filter((id): id is number => id !== null && id !== undefined)
    ),
  ];
  const result = new Map<number, ReleaseRelevance[]>();
  if (!mediaIds.length) return result;

  const requests = await getRepository(MediaRequest).find({
    where: { media: { id: In(mediaIds) } },
  });
  const requestsByMedia = new Map<string, MediaRequest[]>();
  for (const request of requests) {
    const key = `${request.media.id}:${request.is4k}`;
    const bucket = requestsByMedia.get(key) ?? [];
    bucket.push(request);
    requestsByMedia.set(key, bucket);
  }

  for (const occurrence of occurrences) {
    if (!occurrence.mediaId) continue;
    const relevant = (
      requestsByMedia.get(`${occurrence.mediaId}:${occurrence.is4k}`) ?? []
    ).flatMap((request) => {
      const reason = getRequestRelevanceReason(occurrence, request);
      return reason
        ? [
            {
              userId: request.requestedBy.id,
              reason,
              requestId: request.id,
              requestStatus: request.status,
            },
          ]
        : [];
    });
    if (relevant.length) result.set(occurrence.id, relevant);
  }
  return result;
}

export async function getReleaseRelevance(
  occurrence: RelevantOccurrence
): Promise<ReleaseRelevance[]> {
  return (await getReleaseRelevanceMap([occurrence])).get(occurrence.id) ?? [];
}
