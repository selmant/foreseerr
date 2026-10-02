import type TheMovieDb from '@server/api/themoviedb';
import {
  flushMisses,
  listResolutions,
  saveManual,
} from '@server/lib/mapping/resolutions';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { confirmOrRepair } from './validity';

setupTestDb();

/**
 * The three ids measured live on 2026-08-28: present, plausible, and 404 on
 * TMDB. Two are alternate cuts TMDB merged away; the third is a show TMDB split
 * into per-cour series, which is a genuine one-to-many.
 */
const DEAD = new Set(['movie:434021', 'movie:328440', 'tv:327100']);

const http404 = () =>
  Object.assign(new Error('404'), {
    isAxiosError: true,
    response: { status: 404 },
  });

/** `find` answers TMDB's `/find` by external id. */
const fakeTmdb = (
  find: Record<string, { movie?: number[]; tv?: number[] }> = {}
) =>
  ({
    getMovie: async ({ movieId }: { movieId: number }) => {
      if (DEAD.has(`movie:${movieId}`)) throw http404();
      return { id: movieId };
    },
    getTvShow: async ({ tvId }: { tvId: number }) => {
      if (DEAD.has(`tv:${tvId}`)) throw http404();
      return { id: tvId };
    },
    getByExternalId: async ({
      externalId,
    }: {
      externalId: string | number;
    }) => ({
      movie_results: (find[String(externalId)]?.movie ?? []).map((id) => ({
        id,
      })),
      tv_results: (find[String(externalId)]?.tv ?? []).map((id) => ({ id })),
    }),
  }) as unknown as TheMovieDb;

describe('phantom TMDB ids', () => {
  it('leaves a live id untouched', async () => {
    const confirmed = await confirmOrRepair(
      { tmdbId: 76341, mediaType: 'movie', title: 'Mad Max: Fury Road' },
      { tmdb: fakeTmdb() }
    );
    assert.equal(confirmed, undefined, 'a live id needs no intervention');
  });

  it('falls back from a dead alternate-cut id to the base film', async () => {
    // Trakt keeps a Black & Chrome record whose own TMDB id TMDB deleted; the
    // same record's IMDB id still points at the film.
    const confirmed = await confirmOrRepair(
      {
        tmdbId: 434021,
        mediaType: 'movie',
        title: 'Mad Max: Fury Road - Black & Chrome Edition',
        refs: [{ ns: 'imdb', id: 'tt1392190' }],
      },
      {
        discoverSource: 'trakt',
        tmdb: fakeTmdb({ tt1392190: { movie: [76341] } }),
      }
    );
    await flushMisses();

    assert.equal(confirmed?.tmdbId, 76341);
    assert.deepEqual(confirmed?.mappingState, {
      state: 'mapped',
      sourceKey: 'tmdb-find',
      namespace: 'imdb',
      externalId: 'tt1392190',
    });
    assert.equal(
      (await listResolutions('unmapped')).total,
      0,
      'a repaired item is not unmapped'
    );
  });

  it("does not accept the dead id again from another of the item's ids", async () => {
    // The IMDb id still resolves to the record TMDB deleted.
    const confirmed = await confirmOrRepair(
      {
        tmdbId: 328440,
        mediaType: 'movie',
        title: 'The Lord of the Rings: The Two Towers - Extended',
        refs: [{ ns: 'imdb', id: 'tt0167261' }],
      },
      { tmdb: fakeTmdb({ tt0167261: { movie: [328440] } }) }
    );
    assert.equal(confirmed?.tmdbId, undefined);
  });

  it('drops a dead id that cannot be repaired and counts it as unmapped', async () => {
    // Song of the Samurai: Trakt models one show, TMDB split it into 302162 and
    // 320340, so there is no single right answer to substitute.
    const confirmed = await confirmOrRepair(
      {
        tmdbId: 327100,
        mediaType: 'tv',
        title: 'Song of the Samurai',
        refs: [{ ns: 'tvdb_show', id: '444' }],
      },
      {
        discoverSource: 'trakt-list',
        namespace: { ns: 'trakt', id: 'song-of-the-samurai' },
        tmdb: fakeTmdb({ '444': { tv: [302162, 320340] } }),
      }
    );
    await flushMisses();

    assert.equal(confirmed?.tmdbId, undefined);
    assert.equal(confirmed?.mappingState.state, 'unmapped');
    const { results } = await listResolutions('unmapped');
    const sighting = results.find((row) => row.srcNs === 'trakt');
    assert.equal(sighting?.srcId, 'song-of-the-samurai');
    assert.equal(sighting?.detail, 'TMDB tv 327100 no longer exists');
    assert.equal(sighting?.discoverSource, 'trakt-list');
  });

  it('files a failed repair once, under the item and not under each of its ids', async () => {
    await confirmOrRepair(
      {
        tmdbId: 327100,
        mediaType: 'tv',
        title: 'Song of the Samurai',
        refs: [
          { ns: 'imdb', id: 'tt9' },
          { ns: 'tvdb_show', id: '444' },
        ],
      },
      {
        namespace: { ns: 'trakt', id: 'song-of-the-samurai' },
        tmdb: fakeTmdb(),
      }
    );
    await flushMisses();
    const { results } = await listResolutions('unmapped');
    assert.deepEqual(
      results.map((row) => `${row.srcNs}:${row.srcId}`),
      ['trakt:song-of-the-samurai']
    );
  });

  it('lets a correction replace a dead id the source supplied', async () => {
    await saveManual({
      ref: { ns: 'trakt', id: 'song-of-the-samurai' },
      tmdbId: 302162,
      tmdbType: 'tv',
    });
    const confirmed = await confirmOrRepair(
      { tmdbId: 327100, mediaType: 'tv', refs: [{ ns: 'imdb', id: 'tt9' }] },
      {
        namespace: { ns: 'trakt', id: 'song-of-the-samurai' },
        tmdb: fakeTmdb(),
      }
    );
    assert.equal(confirmed?.tmdbId, 302162);
    assert.equal(confirmed?.mappingState.sourceKey, 'manual');
  });

  it('lets a correction override a live id, including its type', async () => {
    await saveManual({
      ref: { ns: 'anilist', id: '5' },
      tmdbId: 11299,
      tmdbType: 'movie',
    });
    const confirmed = await confirmOrRepair(
      { tmdbId: 30991, mediaType: 'tv', refs: [{ ns: 'anilist', id: '5' }] },
      { tmdb: fakeTmdb() }
    );
    assert.deepEqual(
      [confirmed?.tmdbId, confirmed?.mediaType, confirmed?.mappingState.state],
      [11299, 'movie', 'mapped']
    );
  });

  it('leaves the id alone when the correction agrees with it', async () => {
    await saveManual({
      ref: { ns: 'anilist', id: '5' },
      tmdbId: 30991,
      tmdbType: 'tv',
    });
    assert.equal(
      await confirmOrRepair(
        { tmdbId: 30991, mediaType: 'tv', refs: [{ ns: 'anilist', id: '5' }] },
        { tmdb: fakeTmdb() }
      ),
      undefined
    );
  });

  it('does not re-probe a confirmed id on the next render', async () => {
    let calls = 0;
    const counting = {
      getMovie: async ({ movieId }: { movieId: number }) => {
        calls += 1;
        return { id: movieId };
      },
    } as unknown as TheMovieDb;

    for (let i = 0; i < 5; i++) {
      await confirmOrRepair(
        { tmdbId: 76341, mediaType: 'movie' },
        { tmdb: counting }
      );
    }
    assert.equal(calls, 1, 'the alive answer is cached across slider renders');
  });
});
