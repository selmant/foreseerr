import type { Release } from './servarrTypes';

export type ReleaseSort = 'default' | 'newest' | 'smallest' | 'seeders';

export const filterReleaseResults = (
  releases: Release[],
  query: string,
  onlyReady: boolean,
  sort: ReleaseSort
) => {
  const term = query.trim().toLocaleLowerCase();
  const results = releases.filter(
    (release) =>
      (!onlyReady || (!release.rejected && release.downloadAllowed)) &&
      (!term ||
        [release.title, release.quality, release.indexer, release.protocol]
          .filter(Boolean)
          .join(' ')
          .toLocaleLowerCase()
          .includes(term))
  );
  if (sort === 'newest') results.sort((a, b) => a.ageHours - b.ageHours);
  if (sort === 'smallest') results.sort((a, b) => a.size - b.size);
  if (sort === 'seeders')
    results.sort((a, b) => (b.seeders ?? -1) - (a.seeders ?? -1));
  return results;
};
