import TheMovieDb from '@server/api/themoviedb';
import { ANIME_KEYWORD_ID } from '@server/api/themoviedb/constants';
import type { TmdbKeyword } from '@server/api/themoviedb/interfaces';
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

  it('keeps anime items for movie and TV', async () => {
    const animeMovie: TraktMediaItem = {
      mediaType: 'movie',
      tmdbId: 1,
      title: 'Anime Movie',
    };
    const filtered = await filterTraktAnimeItems(
      [tvAnime, tvSeries, movie, animeMovie],
      tmdb
    );
    assert.deepEqual(filtered, [tvAnime, animeMovie]);
  });

  it('removes anime items but keeps non-anime movies and TV', async () => {
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

  it('classifies anime via real TMDB movie {keywords} and TV {results} fixtures', async () => {
    const animeMovie: TraktMediaItem = {
      mediaType: 'movie',
      tmdbId: 129,
      title: 'Spirited Away',
    };
    const animeShow: TraktMediaItem = {
      mediaType: 'tv',
      tmdbId: 1429,
      title: 'Attack on Titan',
    };
    const drama: TraktMediaItem = {
      mediaType: 'tv',
      tmdbId: 1396,
      title: 'Breaking Bad',
    };

    const tmdb = new TheMovieDb();
    (
      tmdb as unknown as {
        get: (path: string) => Promise<unknown>;
      }
    ).get = async (path: string) => {
      if (path === '/movie/129/keywords') {
        return {
          id: 129,
          keywords: [{ id: ANIME_KEYWORD_ID, name: 'anime' } as TmdbKeyword],
        };
      }
      if (path === '/tv/1429/keywords') {
        return {
          id: 1429,
          results: [{ id: ANIME_KEYWORD_ID, name: 'anime' } as TmdbKeyword],
        };
      }
      if (path === '/tv/1396/keywords') {
        return {
          id: 1396,
          results: [{ id: 12345, name: 'crime' } as TmdbKeyword],
        };
      }
      throw new Error(`Unexpected path ${path}`);
    };

    const filtered = await filterTraktAnimeItems(
      [animeMovie, animeShow, drama],
      tmdb
    );
    assert.deepEqual(filtered, [animeMovie, animeShow]);
  });

  it('propagates TMDB keyword provider failures instead of treating items as non-anime', async () => {
    // Use an uncached tmdbId — anime-keyword results are memoized on the shared TMDB cache.
    const uncached: TraktMediaItem = {
      mediaType: 'tv',
      tmdbId: 9_900_001,
      title: 'Uncached Show',
    };
    const failing = {
      mediaHasAnimeKeyword: async () => {
        throw new Error('[TMDB] Failed to fetch keywords: upstream down');
      },
    } as unknown as TheMovieDb;

    await assert.rejects(
      () => filterTraktAnimeItems([uncached], failing),
      /Failed to fetch keywords/
    );
    await assert.rejects(
      () => excludeTraktAnimeItems([uncached], failing),
      /Failed to fetch keywords/
    );
  });
});
