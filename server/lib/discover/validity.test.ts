import type TheMovieDb from '@server/api/themoviedb';
import { getRepository } from '@server/datasource';
import { MappingCluster } from '@server/entity/MappingCluster';
import { MappingGap } from '@server/entity/MappingGap';
import { MappingLink } from '@server/entity/MappingLink';
import { MappingOverride } from '@server/entity/MappingOverride';
import { clearNegativeCache } from '@server/lib/mapping/budget';
import { flushMappingGaps } from '@server/lib/mapping/gaps';
import { upsertCluster } from '@server/lib/mapping/graph';
import mappingService from '@server/lib/mapping/service';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { confirmOrRepair, resetTmdbValidityCache } from './validity';

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

const fakeTmdb = (alive: (key: string) => boolean = (key) => !DEAD.has(key)) =>
  ({
    getMovie: async ({ movieId }: { movieId: number }) => {
      if (!alive(`movie:${movieId}`)) throw http404();
      return { id: movieId };
    },
    getTvShow: async ({ tvId }: { tvId: number }) => {
      if (!alive(`tv:${tvId}`)) throw http404();
      return { id: tvId };
    },
  }) as unknown as TheMovieDb;

beforeEach(async () => {
  resetTmdbValidityCache();
  clearNegativeCache();
  mappingService.invalidate();
  await flushMappingGaps();
  for (const entity of [
    MappingLink,
    MappingCluster,
    MappingOverride,
    MappingGap,
  ]) {
    await getRepository(entity).clear();
  }
});

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
    await upsertCluster([
      { ref: { ns: 'imdb', id: 'tt1392190' }, confidence: 90, sourceKey: 'x' },
      {
        ref: { ns: 'tmdb_movie', id: '76341' },
        confidence: 90,
        sourceKey: 'x',
      },
    ]);

    const confirmed = await confirmOrRepair(
      {
        tmdbId: 434021,
        mediaType: 'movie',
        title: 'Mad Max: Fury Road - Black & Chrome Edition',
        refs: [{ ns: 'imdb', id: 'tt1392190' }],
      },
      { discoverSource: 'trakt', tmdb: fakeTmdb() }
    );

    assert.equal(confirmed?.tmdbId, 76341);
    assert.equal(confirmed?.mappingState.state, 'mapped');
  });

  it('records the dead id it rejected, so the failure is countable', async () => {
    await upsertCluster([
      { ref: { ns: 'imdb', id: 'tt0167261' }, confidence: 90, sourceKey: 'x' },
      { ref: { ns: 'tmdb_movie', id: '121' }, confidence: 90, sourceKey: 'x' },
    ]);

    const confirmed = await confirmOrRepair(
      {
        tmdbId: 328440,
        mediaType: 'movie',
        title: 'The Lord of the Rings: The Two Towers - Extended',
        refs: [{ ns: 'imdb', id: 'tt0167261' }],
      },
      { discoverSource: 'trakt-list', tmdb: fakeTmdb() }
    );
    await flushMappingGaps();

    assert.equal(confirmed?.tmdbId, 121);
    const gap = await getRepository(MappingGap).findOne({
      where: { externalId: 'tt0167261' },
    });
    assert.equal(gap?.reason, 'phantom');
    assert.equal(gap?.rejectedTarget, 'tmdb_movie:328440');
  });

  it('drops a dead id that cannot be repaired instead of rendering it', async () => {
    // Song of the Samurai: Trakt models one show, TMDB split it into 302162 and
    // 320340, so there is no single right answer to substitute.
    const confirmed = await confirmOrRepair(
      {
        tmdbId: 327100,
        mediaType: 'tv',
        title: 'Song of the Samurai',
        refs: [{ ns: 'trakt', id: 'song-of-the-samurai' }],
      },
      { discoverSource: 'trakt-list', tmdb: fakeTmdb() }
    );
    await flushMappingGaps();

    assert.equal(confirmed?.tmdbId, undefined);
    assert.equal(confirmed?.mappingState.state, 'unmapped');
    const gap = await getRepository(MappingGap).findOne({
      where: { externalId: 'song-of-the-samurai' },
    });
    assert.equal(gap?.rejectedTarget, 'tmdb_show:327100');
  });

  it('reports a cour split as an ambiguity rather than picking one', async () => {
    // Both per-cour series are legitimate answers for the one Trakt record.
    await upsertCluster([
      {
        ref: { ns: 'trakt', id: 'song-of-the-samurai' },
        confidence: 80,
        sourceKey: 'a',
      },
      {
        ref: { ns: 'tmdb_show', id: '302162' },
        confidence: 80,
        sourceKey: 'a',
      },
    ]);
    await upsertCluster([
      {
        ref: { ns: 'trakt', id: 'song-of-the-samurai' },
        confidence: 80,
        sourceKey: 'b',
      },
      {
        ref: { ns: 'tmdb_show', id: '320340' },
        confidence: 80,
        sourceKey: 'b',
      },
    ]);

    const confirmed = await confirmOrRepair(
      {
        tmdbId: 327100,
        mediaType: 'tv',
        title: 'Song of the Samurai',
        refs: [{ ns: 'trakt', id: 'song-of-the-samurai' }],
      },
      { discoverSource: 'trakt-list', tmdb: fakeTmdb() }
    );

    assert.equal(confirmed?.tmdbId, undefined);
    assert.equal(
      confirmed?.mappingState.state,
      'ambiguous',
      'two per-cour series are a question, not a coin toss'
    );
  });

  it('flags a live id whose title and year both disagree, without hiding it', async () => {
    // The 63% collision class: the id resolves, so the card renders, and today
    // nothing compares the Simkl title with the film TMDB actually returns.
    const wrongFilm = {
      getMovie: async () => ({
        id: 313599,
        title: 'Artistenblut',
        original_title: 'Artistenblut',
        release_date: '1949-01-01',
      }),
    } as unknown as TheMovieDb;

    const confirmed = await confirmOrRepair(
      {
        tmdbId: 313599,
        mediaType: 'movie',
        title: 'Attack on Titan Final Season',
        year: 2023,
        refs: [{ ns: 'simkl', id: '1234' }],
      },
      { discoverSource: 'simkl-best-anime', tmdb: wrongFilm }
    );
    await flushMappingGaps();

    assert.equal(confirmed, undefined, 'a live id is still rendered');
    const gap = await getRepository(MappingGap).findOne({
      where: { externalId: '1234' },
    });
    assert.equal(gap?.sourceKey, 'title-divergence');
    assert.equal(gap?.rejectedTarget, 'tmdb_movie:313599');
  });

  it('does not flag romaji against English when the years agree', async () => {
    // `Kimi no Na wa.` is *Your Name.* — the trap that forced two reverts.
    const yourName = {
      getMovie: async () => ({
        id: 372058,
        title: 'Your Name.',
        original_title: '君の名は。',
        release_date: '2016-08-26',
      }),
    } as unknown as TheMovieDb;

    await confirmOrRepair(
      {
        tmdbId: 372058,
        mediaType: 'movie',
        title: 'Kimi no Na wa.',
        year: 2016,
        refs: [{ ns: 'anilist', id: '21519' }],
      },
      { discoverSource: 'anilist-trending', tmdb: yourName }
    );
    await flushMappingGaps();

    assert.equal(
      await getRepository(MappingGap).count(),
      0,
      'a localised title is not evidence of a wrong mapping'
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
