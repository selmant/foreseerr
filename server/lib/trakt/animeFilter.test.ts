import type TheMovieDb from '@server/api/themoviedb';
import type { TraktMediaItem } from '@server/api/trakt/interfaces';
import {
  applyTraktMediaTypeFilter,
  excludeTraktAnimeItems,
  filterTraktAnimeItems,
} from '@server/lib/trakt/animeFilter';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const tvAnime: TraktMediaItem = {
  mediaType: 'tv',
  tmdbId: 1,
  title: 'Anime Show',
};

const tvSeries: TraktMediaItem = {
  mediaType: 'tv',
  tmdbId: 2,
  title: 'Drama Show',
};

const movie: TraktMediaItem = {
  mediaType: 'movie',
  tmdbId: 3,
  title: 'Movie',
};

function createTmdbStub(animeIds: Set<number>): TheMovieDb {
  return {
    mediaHasAnimeKeyword: async ({
      tmdbId,
    }: {
      mediaType: 'movie' | 'tv';
      tmdbId: number;
    }) => animeIds.has(tmdbId),
  } as TheMovieDb;
}

describe('Trakt anime filters', () => {
  const tmdb = createTmdbStub(new Set([1]));

  it('keeps only anime TV items', async () => {
    const filtered = await filterTraktAnimeItems(
      [tvAnime, tvSeries, movie],
      tmdb
    );
    assert.deepEqual(filtered, [tvAnime]);
  });

  it('removes anime TV items but keeps movies and regular TV', async () => {
    const filtered = await excludeTraktAnimeItems(
      [tvAnime, tvSeries, movie],
      tmdb
    );
    assert.deepEqual(filtered, [tvSeries, movie]);
  });

  it('applies tv and anime filters from the media type selection', async () => {
    const pool = [tvAnime, tvSeries, movie];

    assert.deepEqual(await applyTraktMediaTypeFilter(pool, 'anime', tmdb), [
      tvAnime,
    ]);
    assert.deepEqual(
      await applyTraktMediaTypeFilter([tvAnime, tvSeries], 'tv', tmdb),
      [tvSeries]
    );
    assert.deepEqual(await applyTraktMediaTypeFilter(pool, 'both', tmdb), [
      tvSeries,
      movie,
    ]);
    assert.deepEqual(
      await applyTraktMediaTypeFilter(pool, 'movie', tmdb),
      pool
    );
  });
});
