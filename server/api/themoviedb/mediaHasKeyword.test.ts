import TheMovieDb from '@server/api/themoviedb';
import { ANIME_KEYWORD_ID } from '@server/api/themoviedb/constants';
import type { TmdbKeyword } from '@server/api/themoviedb/interfaces';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/** Representative TMDB movie keywords payload (`/movie/{id}/keywords`). */
const MOVIE_ANIME_KEYWORDS = {
  id: 129,
  keywords: [{ id: ANIME_KEYWORD_ID, name: 'anime' } as TmdbKeyword],
};

/** Representative TMDB TV keywords payload (`/tv/{id}/keywords`). */
const TV_ANIME_KEYWORDS = {
  id: 1429,
  results: [{ id: ANIME_KEYWORD_ID, name: 'anime' } as TmdbKeyword],
};

const MOVIE_NO_ANIME = {
  id: 550,
  keywords: [{ id: 9715, name: 'superhero' } as TmdbKeyword],
};

const TV_NO_ANIME = {
  id: 1396,
  results: [{ id: 12345, name: 'crime' } as TmdbKeyword],
};

function stubKeywordGet(
  tmdb: TheMovieDb,
  responses: Record<string, unknown>
): void {
  (
    tmdb as unknown as {
      get: (path: string) => Promise<unknown>;
    }
  ).get = async (path: string) => {
    if (path in responses) {
      return responses[path];
    }
    throw Object.assign(new Error(`Unexpected path ${path}`), {
      response: { status: 500 },
    });
  };
}

describe('TheMovieDb.mediaHasKeyword', () => {
  it('detects anime keyword on movie {keywords} shape', async () => {
    const tmdb = new TheMovieDb();
    stubKeywordGet(tmdb, {
      '/movie/129/keywords': MOVIE_ANIME_KEYWORDS,
    });

    assert.equal(
      await tmdb.mediaHasKeyword({
        mediaType: 'movie',
        tmdbId: 129,
        keywordId: ANIME_KEYWORD_ID,
      }),
      true
    );
  });

  it('detects anime keyword on TV {results} shape', async () => {
    const tmdb = new TheMovieDb();
    stubKeywordGet(tmdb, {
      '/tv/1429/keywords': TV_ANIME_KEYWORDS,
    });

    assert.equal(
      await tmdb.mediaHasKeyword({
        mediaType: 'tv',
        tmdbId: 1429,
        keywordId: ANIME_KEYWORD_ID,
      }),
      true
    );
  });

  it('returns false when keyword is absent on a successful movie response', async () => {
    const tmdb = new TheMovieDb();
    stubKeywordGet(tmdb, {
      '/movie/550/keywords': MOVIE_NO_ANIME,
    });

    assert.equal(
      await tmdb.mediaHasKeyword({
        mediaType: 'movie',
        tmdbId: 550,
        keywordId: ANIME_KEYWORD_ID,
      }),
      false
    );
  });

  it('returns false when keyword is absent on a successful TV response', async () => {
    const tmdb = new TheMovieDb();
    stubKeywordGet(tmdb, {
      '/tv/1396/keywords': TV_NO_ANIME,
    });

    assert.equal(
      await tmdb.mediaHasKeyword({
        mediaType: 'tv',
        tmdbId: 1396,
        keywordId: ANIME_KEYWORD_ID,
      }),
      false
    );
  });

  it('throws a distinguishable error on provider failure instead of false', async () => {
    const tmdb = new TheMovieDb();
    (
      tmdb as unknown as {
        get: () => Promise<unknown>;
      }
    ).get = async () => {
      throw Object.assign(new Error('ECONNRESET'), {
        response: { status: 503 },
      });
    };

    await assert.rejects(
      () =>
        tmdb.mediaHasKeyword({
          mediaType: 'movie',
          tmdbId: 129,
          keywordId: ANIME_KEYWORD_ID,
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /\[TMDB\].*keyword/i);
        return true;
      }
    );
  });
});
