import TheMovieDb from '@server/api/themoviedb';
import cacheManager from '@server/lib/cache';
import assert from 'node:assert/strict';
import { it } from 'node:test';

it('keeps narrow scan details separate from full TV details', async () => {
  const regular = cacheManager.getCache('tmdb');
  const scan = cacheManager.getCache('tmdbscan');
  regular.flush();
  scan.flush();

  const calls: string[] = [];
  const tmdb = new TheMovieDb();
  const transport = tmdb as unknown as {
    axios: {
      get: (
        endpoint: string,
        config: { params: { append_to_response: string } }
      ) => Promise<{ data: unknown }>;
    };
  };
  transport.axios.get = async (endpoint, config) => {
    assert.equal(endpoint, '/tv/987654');
    calls.push(config.params.append_to_response);
    return {
      data: {
        id: 987654,
        name: 'Test Show',
        seasons: [],
        external_ids: {},
        keywords: { results: [] },
        videos: { results: [] },
        aggregate_credits: { cast: [], crew: [{ id: 1 }] },
        credits: { crew: [], cast: [{ id: 2 }] },
      },
    };
  };

  try {
    const scanShow = await tmdb.getTvShowForScan({
      tvId: 987654,
      language: 'en',
    });
    const fullShow = await tmdb.getTvShow({ tvId: 987654, language: 'en' });
    await tmdb.getTvShowForScan({ tvId: 987654, language: 'en' });

    assert.equal(scanShow.id, fullShow.id);
    assert.deepEqual(calls, [
      'keywords,external_ids',
      'aggregate_credits,credits,external_ids,keywords,videos,content_ratings,watch/providers',
    ]);
    assert.equal(scan.getStats().keys, 1);
    assert.equal(regular.getStats().keys, 1);
    assert.equal(fullShow.aggregate_credits.cast.length, 0);
    assert.equal(fullShow.credits.crew.length, 0);
    assert.equal('crew' in fullShow.aggregate_credits, false);
    assert.equal('cast' in fullShow.credits, false);
  } finally {
    regular.flush();
    scan.flush();
  }
});

it('resolves scanner external IDs with short lived cache entries', async () => {
  const regular = cacheManager.getCache('tmdb');
  const scan = cacheManager.getCache('tmdbscan');
  regular.flush();
  scan.flush();

  const calls: string[] = [];
  const tmdb = new TheMovieDb();
  const transport = tmdb as unknown as {
    axios: { get: (endpoint: string) => Promise<{ data: unknown }> };
  };
  transport.axios.get = async (endpoint) => {
    calls.push(endpoint);
    if (endpoint === '/find/tt987654') {
      return { data: { movie_results: [{ id: 12345 }], tv_results: [] } };
    }
    if (endpoint === '/movie/12345') return { data: { id: 12345 } };
    if (endpoint === '/find/777777') {
      return { data: { movie_results: [], tv_results: [{ id: 987654 }] } };
    }
    if (endpoint === '/tv/987654') {
      return {
        data: {
          id: 987654,
          name: 'Test Show',
          seasons: [],
          external_ids: {},
          keywords: { results: [] },
        },
      };
    }
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  try {
    assert.equal(
      await tmdb.resolveImdbIdForScan({ imdbId: 'tt987654' }),
      12345
    );
    assert.equal(
      (await tmdb.getShowByTvdbIdForScan({ tvdbId: 777777 })).id,
      987654
    );
    assert.deepEqual(calls, [
      '/find/tt987654',
      '/movie/12345',
      '/find/777777',
      '/tv/987654',
    ]);
    assert.equal(regular.getStats().keys, 0);
    assert.equal(scan.getStats().keys, 4);
  } finally {
    regular.flush();
    scan.flush();
  }
});
