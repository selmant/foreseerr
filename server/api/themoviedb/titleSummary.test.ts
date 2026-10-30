import TheMovieDb from '@server/api/themoviedb';
import cacheManager from '@server/lib/cache';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';

type Transport = {
  axios: {
    get: (
      endpoint: string,
      config: { params: Record<string, string> }
    ) => Promise<{ data: unknown }>;
  };
};

const tmdbWith = (calls: Record<string, string>[]) => {
  const tmdb = new TheMovieDb();
  (tmdb as unknown as Transport).axios.get = async (endpoint, config) => {
    calls.push({ endpoint, ...config.params });
    return {
      data: {
        id: Number(endpoint.split('/').pop()),
        title: 'Summary',
        poster_path: '/summary.jpg',
        vote_average: 6.4,
        videos: { results: [{ type: 'Trailer', key: 'k' }] },
      },
    };
  };
  return tmdb;
};

beforeEach(() => cacheManager.getCache('tmdb').flush());
afterEach(() => cacheManager.getCache('tmdb').flush());

it('asks for the bare record and shares it with the browse metadata', async () => {
  const calls: Record<string, string>[] = [];
  const tmdb = tmdbWith(calls);
  const summary = await tmdb.getTitleSummary({
    mediaType: 'movie',
    tmdbId: 9_700_001,
    language: 'en',
  });
  assert.equal(summary.poster_path, '/summary.jpg');
  assert.equal(summary.vote_average, 6.4);
  await tmdb.getMovieBrowseMetadata({ movieId: 9_700_001, language: 'en' });
  assert.deepEqual(calls, [{ endpoint: '/movie/9700001', language: 'en' }]);
});

it('reuses a full details answer that is already cached', async () => {
  const calls: Record<string, string>[] = [];
  const tmdb = tmdbWith(calls);
  await tmdb.getTvShow({ tvId: 9_700_002, language: 'en' });
  const summary = await tmdb.getTitleSummary({
    mediaType: 'tv',
    tmdbId: 9_700_002,
    language: 'en',
  });
  assert.equal(summary.poster_path, '/summary.jpg');
  assert.equal(calls.length, 1, 'no second request');
  assert.equal(
    calls[0].append_to_response,
    'aggregate_credits,credits,external_ids,keywords,videos,content_ratings,watch/providers'
  );
});
