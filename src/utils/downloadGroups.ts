import defineMessages from '@app/utils/defineMessages';
import type { DownloadingItem } from '@shared/lib/downloadtracker';
import type { IntlShape } from 'react-intl';

const messages = defineMessages('utils.downloadGroups', {
  pack: '{seasons} pack ({count, plural, one {# ep} other {# eps}})',
  episodes: '{seasons} ({count, plural, one {# ep} other {# eps}})',
});

/** The tracker items of one download, in tracker order. */
export type DownloadGroup = { item: DownloadingItem; items: DownloadingItem[] };

/**
 * Which download an item belongs to: its `downloadId`, or for an item
 * without one (a pending, delayed Sonarr download) its title and status,
 * and its series or movie.
 */
const downloadKey = (item: DownloadingItem): string =>
  item.downloadId
    ? `id:${item.downloadId}`
    : `pending:${JSON.stringify([item.externalId, item.status, item.title])}`;

/**
 * The downloads among tracker items. The tracker lists a download of several
 * episodes once per episode, each with the download's `downloadId`, or, while
 * the download is pending, each without one.
 */
export const groupDownloads = (
  items: DownloadingItem[] = []
): DownloadGroup[] => {
  const groups: DownloadGroup[] = [];
  const byKey = new Map<string, DownloadGroup>();
  for (const item of items) {
    const key = downloadKey(item);
    const group = byKey.get(key);
    if (group) {
      group.items.push(item);
      continue;
    }
    const created = { item, items: [item] };
    groups.push(created);
    byKey.set(key, created);
  }
  return groups;
};

/** What one download covers. */
export type DownloadScope =
  | { kind: 'episode'; seasonNumber: number; episodeNumber: number }
  | { kind: 'range'; seasonNumber: number; first: number; last: number }
  | { kind: 'pack'; seasonNumbers: number[]; episodeCount: number }
  | { kind: 'episodes'; seasonNumbers: number[]; episodeCount: number };

/**
 * What the items of one download cover, from their episodes and, on
 * Sonarr 5, the download's seasons and full-season flag. `undefined` for a
 * movie or a download without episode details.
 */
export const downloadScope = (
  items: DownloadingItem[]
): DownloadScope | undefined => {
  const seen = new Set<string>();
  const episodes = items
    .flatMap((item) => (item.episode ? [item.episode] : []))
    .filter((episode) => {
      const key = `${episode.seasonNumber}:${episode.episodeNumber}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(
      (a, b) =>
        a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber
    );
  const seasons = items.find((item) => item.seasons?.length)?.seasons;
  const seasonNumbers = [
    ...new Set(
      seasons?.length
        ? seasons.map((season) => season.seasonNumber)
        : episodes.map((episode) => episode.seasonNumber)
    ),
  ].sort((a, b) => a - b);
  if (!seasonNumbers.length) return undefined;
  const episodeCount = seasons?.length
    ? seasons.reduce((sum, season) => sum + season.episodeCount, 0)
    : episodes.length;
  if (items.some((item) => item.isFullSeason)) {
    return { kind: 'pack', seasonNumbers, episodeCount };
  }
  if (
    episodes.length &&
    seasonNumbers.length === 1 &&
    episodes.length === episodeCount
  ) {
    const [first] = episodes;
    const last = episodes[episodes.length - 1];
    if (episodes.length === 1) {
      return {
        kind: 'episode',
        seasonNumber: first.seasonNumber,
        episodeNumber: first.episodeNumber,
      };
    }
    if (
      episodes.every(
        (episode, index) =>
          episode.episodeNumber === first.episodeNumber + index
      )
    ) {
      return {
        kind: 'range',
        seasonNumber: first.seasonNumber,
        first: first.episodeNumber,
        last: last.episodeNumber,
      };
    }
  }
  return { kind: 'episodes', seasonNumbers, episodeCount };
};

const pad = (n: number) => String(n).padStart(2, '0');

/** `S01–S03`, or `S01, S03` when a season is missing in between. */
const seasonList = (seasonNumbers: number[]) => {
  const first = seasonNumbers[0];
  const last = seasonNumbers[seasonNumbers.length - 1];
  if (seasonNumbers.length === 1) return `S${pad(first)}`;
  return last - first === seasonNumbers.length - 1
    ? `S${pad(first)}–S${pad(last)}`
    : seasonNumbers.map((n) => `S${pad(n)}`).join(', ');
};

/** E.g. `S01E02`, `S01E02–E03`, `S02 pack (10 eps)` or `S01 (3 eps)`. */
export const formatDownloadScope = (
  intl: IntlShape,
  scope: DownloadScope
): string => {
  switch (scope.kind) {
    case 'episode':
      return `S${pad(scope.seasonNumber)}E${pad(scope.episodeNumber)}`;
    case 'range':
      return `S${pad(scope.seasonNumber)}E${pad(scope.first)}–E${pad(scope.last)}`;
    case 'pack':
      return intl.formatMessage(messages.pack, {
        seasons: seasonList(scope.seasonNumbers),
        count: scope.episodeCount,
      });
    case 'episodes':
      return intl.formatMessage(messages.episodes, {
        seasons: seasonList(scope.seasonNumbers),
        count: scope.episodeCount,
      });
  }
};

/** The label of a download's items, or `undefined` when they have none. */
export const downloadLabel = (
  intl: IntlShape,
  items: DownloadingItem[]
): string | undefined => {
  const scope = downloadScope(items);
  return scope && formatDownloadScope(intl, scope);
};
