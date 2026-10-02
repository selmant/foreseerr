import { AnilistRateLimitedError } from '@server/api/anilist';
import type TheMovieDb from '@server/api/themoviedb';
import { getRepository } from '@server/datasource';
import { MappingResolution } from '@server/entity/MappingResolution';
import { setupTestDb } from '@server/test/db';
import { edge, seedEdges } from '@server/test/mapping';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DeriveDeps } from './derive';
import {
  flushMisses,
  listResolutions,
  recordMiss,
  saveManual,
  saveResolution,
} from './resolutions';
import { invalidateResolutions, resolveTmdb } from './resolve';

setupTestDb();

/** A TMDB stub whose `/find` answers by external id and counts its calls. */
const findStub = (
  answers: Record<string, { movie?: number[]; tv?: number[] }>
): TheMovieDb & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    getByExternalId: async ({
      externalId,
    }: {
      externalId: string | number;
    }) => {
      calls.push(String(externalId));
      const answer = answers[String(externalId)] ?? {};
      return {
        movie_results: (answer.movie ?? []).map((id) => ({ id })),
        tv_results: (answer.tv ?? []).map((id) => ({ id })),
      };
    },
  } as unknown as TheMovieDb & { calls: string[] };
};

const noDerive: Partial<DeriveDeps> = {
  search: async () => [],
  anilistMedia: async () => null,
};

const rows = () => getRepository(MappingResolution).find();

describe('resolveTmdb order', () => {
  it('lets a manual correction beat the dataset', async () => {
    await seedEdges(edge('anilist:1', 'tmdb_show:10:s1'));
    await saveManual({
      ref: { ns: 'anilist', id: '1' },
      tmdbId: 999,
      tmdbType: 'tv',
    });
    assert.deepEqual(
      await resolveTmdb({
        refs: [{ ns: 'anilist', id: '1' }],
        mediaType: 'tv',
      }),
      { tmdbId: 999, mediaType: 'tv', origin: 'manual' }
    );
  });

  it('treats a manual row without an id as "has no TMDB counterpart"', async () => {
    await seedEdges(edge('anilist:1', 'tmdb_show:10:s1'));
    await saveManual({ ref: { ns: 'anilist', id: '1' }, tmdbId: null });
    assert.equal(
      await resolveTmdb({
        refs: [{ ns: 'anilist', id: '1' }],
        mediaType: 'tv',
      }),
      undefined
    );
  });

  it('answers from the dataset without touching the network', async () => {
    await seedEdges(edge('anilist:1', 'tmdb_show:10:s2'));
    const tmdb = findStub({});
    assert.deepEqual(
      await resolveTmdb({
        refs: [{ ns: 'anilist', id: '1' }],
        mediaType: 'tv',
        tmdb,
      }),
      { tmdbId: 10, mediaType: 'tv', season: 2, origin: 'dataset' }
    );
    assert.deepEqual(tmdb.calls, []);
    assert.deepEqual(await rows(), []);
  });

  it('falls back to TMDB find by IMDb id and remembers the answer', async () => {
    const tmdb = findStub({ tt0903747: { tv: [1396] } });
    const request = {
      refs: [{ ns: 'imdb' as const, id: 'tt0903747' }],
      identity: { ns: 'trakt' as const, id: 'breaking-bad' },
      mediaType: 'tv' as const,
      tmdb,
    };
    assert.deepEqual(await resolveTmdb(request), {
      tmdbId: 1396,
      mediaType: 'tv',
      origin: 'tmdb-find',
    });

    invalidateResolutions();
    assert.equal((await resolveTmdb(request))?.tmdbId, 1396);
    // The second lookup read the stored row.
    assert.deepEqual(tmdb.calls, ['tt0903747']);
    const [stored] = await rows();
    assert.deepEqual(
      [stored.srcNs, stored.srcId, stored.origin, stored.tmdbId],
      ['imdb', 'tt0903747', 'tmdb-find', 1396]
    );
  });

  it('keeps to the declared type: a show is not an answer for a movie', async () => {
    const tmdb = findStub({ tt1: { tv: [5] } });
    assert.equal(
      await resolveTmdb({
        refs: [{ ns: 'imdb', id: 'tt1' }],
        mediaType: 'movie',
        tmdb,
      }),
      undefined
    );
  });

  it('settles the type from the answer when the source declared none', async () => {
    const tmdb = findStub({ tt2: { tv: [7] } });
    assert.deepEqual(
      await resolveTmdb({ refs: [{ ns: 'imdb', id: 'tt2' }], tmdb }),
      { tmdbId: 7, mediaType: 'tv', origin: 'tmdb-find' }
    );
  });

  it('does not pick between several records for one id', async () => {
    const tmdb = findStub({ '73740': { tv: [1, 2] } });
    assert.equal(
      await resolveTmdb({
        refs: [{ ns: 'tvdb_show', id: '73740' }],
        mediaType: 'tv',
        tmdb,
      }),
      undefined
    );
  });

  it('asks TMDB about a TVDB show whose only dataset edge is a film in its specials', async () => {
    await seedEdges(edge('tvdb_show:72499:s0', 'tmdb_movie:1857'));
    const tmdb = findStub({ '72499': { tv: [4613] } });
    assert.deepEqual(
      await resolveTmdb({
        refs: [{ ns: 'tvdb_show', id: '72499' }],
        mediaType: 'tv',
        tmdb,
      }),
      { tmdbId: 4613, mediaType: 'tv', origin: 'tmdb-find' }
    );
  });

  it('never asks TMDB for a movie by TVDB id', async () => {
    const tmdb = findStub({ '5': { movie: [50] } });
    await resolveTmdb({
      refs: [{ ns: 'tvdb_show', id: '5' }],
      mediaType: 'movie',
      tmdb,
    });
    assert.deepEqual(tmdb.calls, []);
  });
});

describe('resolveTmdb anime fallback', () => {
  const request = (derive: Partial<DeriveDeps>) => ({
    refs: [{ ns: 'anilist' as const, id: '216895' }],
    mediaType: 'tv' as const,
    title: 'Welsh & Shedar',
    discoverSource: 'anilist/season',
    anime: {
      anilistId: 216895,
      titles: ['ウェルシュ'],
      year: 2026,
      format: 'TV',
      relations: [],
    },
    tmdb: findStub({}),
    derive,
  });
  const found: Partial<DeriveDeps> = {
    search: async () => [
      { id: 335788, originalName: 'ウェルシュ', year: 2026, genreIds: [16] },
    ],
    anilistMedia: async () => null,
  };

  it('stores a derived answer as a guess under the AniList id', async () => {
    assert.deepEqual(await resolveTmdb(request(found)), {
      tmdbId: 335788,
      mediaType: 'tv',
      origin: 'title',
    });
    const { results } = await listResolutions('guessed');
    assert.deepEqual(
      [results[0].srcNs, results[0].srcId, results[0].origin, results[0].title],
      ['anilist', '216895', 'title', 'Welsh & Shedar']
    );
  });

  it('lets the dataset supersede a stored guess once it knows the id', async () => {
    await resolveTmdb(request(found));
    await seedEdges(edge('anilist:216895', 'tmdb_show:1:s1'));
    invalidateResolutions();
    assert.deepEqual(await resolveTmdb(request(noDerive)), {
      tmdbId: 1,
      mediaType: 'tv',
      season: 1,
      origin: 'dataset',
    });
    assert.equal(
      (await listResolutions('guessed')).total,
      0,
      'the guess leaves the Guessed list'
    );
  });

  it('remembers a miss and does not repeat the lookups until it expires', async () => {
    let searches = 0;
    const counting: Partial<DeriveDeps> = {
      search: async () => {
        searches += 1;
        return [];
      },
      anilistMedia: async () => null,
    };
    assert.equal(await resolveTmdb(request(counting)), undefined);
    assert.equal(searches, 1);

    invalidateResolutions();
    assert.equal(await resolveTmdb(request(counting)), undefined);
    assert.equal(searches, 1);

    // A day later the miss is stale and the fallback runs again.
    await getRepository(MappingResolution).update(
      { origin: 'miss' },
      { checkedAt: new Date(Date.now() - 25 * 3600 * 1000) }
    );
    invalidateResolutions();
    assert.equal((await resolveTmdb(request(found)))?.tmdbId, 335788);
    // And the item leaves the unmapped list.
    assert.equal((await listResolutions('unmapped')).total, 0);
  });

  it('stays off the network when offline, without recording a miss', async () => {
    const throwing: Partial<DeriveDeps> = {
      search: async () => {
        throw new Error('offline lookups must not search');
      },
    };
    assert.equal(
      await resolveTmdb({ ...request(throwing), offline: true }),
      undefined
    );
    assert.deepEqual(await rows(), []);
  });

  it('does not let a lookup without titles hold back one that has them', async () => {
    const ref = { ns: 'anilist' as const, id: '216895' };
    // Asked about by id alone: nothing can be derived, and nothing was tried.
    assert.equal(
      await resolveTmdb({ refs: [ref], mediaType: 'tv', tmdb: findStub({}) }),
      undefined
    );
    assert.equal((await resolveTmdb(request(found)))?.tmdbId, 335788);
  });

  it('does not reuse a stored show for an item declared as a movie', async () => {
    const tmdb = findStub({ tt9: { tv: [90] } });
    const ref = { ns: 'imdb' as const, id: 'tt9' };
    // First seen on a list that declares no type.
    assert.equal((await resolveTmdb({ refs: [ref], tmdb }))?.mediaType, 'tv');
    assert.equal(
      await resolveTmdb({ refs: [ref], mediaType: 'movie', tmdb }),
      undefined
    );
  });

  it('does not run the fallback for an item that is not anime', async () => {
    let searched = false;
    await resolveTmdb({
      refs: [{ ns: 'trakt', id: 'some-show' }],
      mediaType: 'tv',
      title: 'Some Show',
      year: 2026,
      tmdb: findStub({}),
      derive: {
        search: async () => {
          searched = true;
          return [];
        },
      },
    });
    assert.equal(searched, false);
  });
});

describe('resolveTmdb on a failed lookup', () => {
  it('stores nothing and holds off for a while when AniList is rate limiting', async () => {
    let asked = 0;
    const limited: Partial<DeriveDeps> = {
      search: async () => [],
      anilistMedia: async () => {
        asked += 1;
        throw new AnilistRateLimitedError(30);
      },
    };
    const request = {
      refs: [{ ns: 'anilist' as const, id: '5' }],
      mediaType: 'tv' as const,
      anime: { anilistId: 5, titles: ['New Show'], year: 2026 },
      tmdb: findStub({}),
      derive: limited,
    };
    assert.equal(await resolveTmdb(request), undefined);
    assert.equal(await resolveTmdb(request), undefined);
    assert.equal(asked, 1, 'the second render waits out the backoff');
    assert.deepEqual(await rows(), [], 'a rate limit is not a miss');

    // After the backoff the lookup runs again and can succeed.
    invalidateResolutions();
    assert.equal(
      (
        await resolveTmdb({
          ...request,
          derive: {
            search: async () => [
              { id: 77, originalName: 'New Show', year: 2026, genreIds: [16] },
            ],
            anilistMedia: async () => null,
          },
        })
      )?.tmdbId,
      77
    );
  });
});

describe('saveResolution', () => {
  it('lets two lookups of a new item write at the same time', async () => {
    const write = {
      ref: { ns: 'imdb' as const, id: 'tt5' },
      mediaType: 'movie' as const,
      tmdbId: 5,
      tmdbType: 'movie' as const,
      origin: 'tmdb-find' as const,
    };
    await Promise.all([saveResolution(write), saveResolution(write)]);
    assert.equal((await rows()).length, 1);
  });
});

describe('unmapped sightings', () => {
  it('counts sightings without making a never-tried item look attempted', async () => {
    const ref = { ns: 'anilist' as const, id: '5' };
    recordMiss({ ref, mediaType: 'tv', title: 'New Show' });
    recordMiss({ ref, mediaType: 'tv', discoverSource: 'anilist/trending' });
    await flushMisses();

    const { results } = await listResolutions('unmapped');
    assert.equal(results[0].hitCount, 2);
    assert.equal(results[0].title, 'New Show');
    assert.equal(results[0].discoverSource, 'anilist/trending');

    // The sighting alone must not suppress the first real attempt.
    let searches = 0;
    await resolveTmdb({
      refs: [ref],
      mediaType: 'tv',
      anime: { anilistId: 5, titles: ['New Show'], year: 2026, relations: [] },
      tmdb: findStub({}),
      derive: {
        search: async () => {
          searches += 1;
          return [];
        },
      },
    });
    assert.equal(searches, 1);
  });

  it('never lets a sighting overwrite a correction', async () => {
    const ref = { ns: 'trakt' as const, id: 'some-show' };
    await saveManual({ ref, tmdbId: 42, tmdbType: 'tv', detail: 'checked' });
    recordMiss({ ref, title: 'Some Show' });
    await flushMisses();
    const [row] = await rows();
    assert.deepEqual([row.origin, row.tmdbId], ['manual', 42]);
  });

  it('does not list an item again after it was marked as having no counterpart', async () => {
    const ref = { ns: 'anilist' as const, id: '77' };
    await saveManual({ ref, tmdbId: null });
    recordMiss({ ref, mediaType: 'tv', title: 'Music Video' });
    await flushMisses();
    assert.equal((await listResolutions('unmapped')).total, 0);
  });

  it('drops inferred rows for an item once it is corrected', async () => {
    const ref = { ns: 'simkl' as const, id: '9' };
    recordMiss({ ref, mediaType: 'tv', title: 'Unmapped' });
    await flushMisses();
    await saveManual({ ref, tmdbId: 3, tmdbType: 'tv' });
    assert.deepEqual(
      (await rows()).map((row) => row.origin),
      ['manual']
    );
    assert.equal(
      (await resolveTmdb({ refs: [ref], mediaType: 'tv' }))?.tmdbId,
      3
    );
  });
});
