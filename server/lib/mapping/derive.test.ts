import type { AnilistMedia } from '@server/api/anilist/interfaces';
import { setupTestDb } from '@server/test/db';
import { edge, seedEdges } from '@server/test/mapping';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deriveTmdb, titleKey, type DeriveDeps, type TitleHit } from './derive';

setupTestDb();

const ANIMATION = 16;

const hit = (patch: Partial<TitleHit> & { id: number }): TitleHit => ({
  genreIds: [ANIMATION],
  ...patch,
});

/** A search stub that answers by query and records what was asked. */
const searching = (
  answers: Record<string, TitleHit[]>
): DeriveDeps['search'] & { asked: string[] } => {
  const asked: string[] = [];
  const search = async (_mediaType: string, query: string) => {
    asked.push(query);
    return answers[query] ?? [];
  };
  return Object.assign(search, { asked });
};

const noAnilist: DeriveDeps['anilistMedia'] = async () => {
  throw new Error('AniList should not be asked');
};

const prequel = (id: number, format = 'TV') => ({
  relationType: 'PREQUEL',
  node: { id, type: 'ANIME', format },
});

describe('titleKey', () => {
  it('ignores case, spacing and punctuation, in any script', () => {
    assert.equal(titleKey('SAKAMOTO DAYS'), titleKey('Sakamoto Days'));
    assert.equal(titleKey('ダンダダン 第3期'), titleKey('ダンダダン　第３期'));
    assert.notEqual(titleKey('Owarimonogatari'), titleKey('Monogatari'));
  });
});

describe('exact title rule', () => {
  it('accepts a single exact match in the same year with the Animation genre', async () => {
    const search = searching({
      ウェルシュ: [hit({ id: 335788, originalName: 'ウェルシュ', year: 2026 })],
    });
    const derived = await deriveTmdb(
      { titles: ['ウェルシュ'], year: 2026, relations: [] },
      'tv',
      { search, anilistMedia: noAnilist }
    );
    assert.equal(derived?.tmdbId, 335788);
    assert.equal(derived?.origin, 'title');
  });

  it('rejects a live-action record with the same title and year', async () => {
    const search = searching({
      GTO: [{ id: 62057, originalName: 'GTO', year: 1998, genreIds: [18] }],
    });
    assert.equal(
      await deriveTmdb({ titles: ['GTO'], year: 1999, relations: [] }, 'tv', {
        search,
        anilistMedia: noAnilist,
      }),
      undefined
    );
  });

  it('rejects a near match: similarity is not identity', async () => {
    const search = searching({
      Owarimonogatari: [hit({ id: 46195, name: 'Monogatari', year: 2015 })],
    });
    assert.equal(
      await deriveTmdb(
        { titles: ['Owarimonogatari'], year: 2015, relations: [] },
        'tv',
        { search, anilistMedia: noAnilist }
      ),
      undefined
    );
  });

  it('rejects a remake from another year', async () => {
    const search = searching({
      レイアース: [hit({ id: 1, originalName: 'レイアース', year: 1994 })],
    });
    assert.equal(
      await deriveTmdb(
        { titles: ['レイアース'], year: 2026, relations: [] },
        'tv',
        { search, anilistMedia: noAnilist }
      ),
      undefined
    );
  });

  it('gives up on two exact matches rather than trying another spelling', async () => {
    const search = searching({
      Echo: [
        hit({ id: 1, name: 'Echo', year: 2026 }),
        hit({ id: 2, name: 'Echo', year: 2026 }),
      ],
      エコー: [hit({ id: 3, originalName: 'エコー', year: 2026 })],
    });
    assert.equal(
      await deriveTmdb(
        { titles: ['Echo', 'エコー'], year: 2026, relations: [] },
        'movie',
        { search, anilistMedia: noAnilist }
      ),
      undefined
    );
    assert.deepEqual(search.asked, ['Echo']);
  });

  it('does not guess without a year', async () => {
    const search = searching({
      Echo: [hit({ id: 1, name: 'Echo', year: 2026 })],
    });
    assert.equal(
      await deriveTmdb({ titles: ['Echo'], relations: [] }, 'movie', {
        search,
        anilistMedia: noAnilist,
      }),
      undefined
    );
    assert.deepEqual(search.asked, []);
  });
});

describe('prequel rule', () => {
  it('inherits the show of the nearest mapped prequel', async () => {
    await seedEdges(edge('anilist:171018', 'tmdb_show:240411:s1'));
    const derived = await deriveTmdb(
      {
        anilistId: 198966,
        titles: ['ダンダダン 第3期'],
        year: 2027,
        format: 'TV',
        relations: [prequel(185660)],
      },
      'tv',
      {
        search: searching({}),
        // Season 2 is not mapped either, so its own prequel is asked for.
        anilistMedia: async (id) =>
          id === 185660
            ? ({ id, relations: { edges: [prequel(171018)] } } as AnilistMedia)
            : null,
      }
    );
    assert.deepEqual(
      [derived?.tmdbId, derived?.mediaType, derived?.origin],
      [240411, 'tv', 'prequel']
    );
  });

  it('prefers an exact title match over the prequel, for a sequel TMDB files on its own', async () => {
    await seedEdges(edge('anilist:20', 'tmdb_show:46260:s1'));
    const derived = await deriveTmdb(
      {
        anilistId: 1735,
        titles: ['NARUTO -ナルト- 疾風伝'],
        year: 2007,
        format: 'TV',
        relations: [prequel(20)],
      },
      'tv',
      {
        search: searching({
          'NARUTO -ナルト- 疾風伝': [
            hit({ id: 31910, originalName: 'ナルト 疾風伝', year: 2007 }),
            hit({
              id: 31911,
              originalName: 'NARUTO -ナルト- 疾風伝',
              year: 2007,
            }),
          ],
        }),
        anilistMedia: noAnilist,
      }
    );
    assert.equal(derived?.tmdbId, 31911);
    assert.equal(derived?.origin, 'title');
  });

  it('ignores a film prequel and never applies to a film', async () => {
    await seedEdges([
      ...edge('anilist:50', 'tmdb_movie:500'),
      ...edge('anilist:60', 'tmdb_show:600:s1'),
    ]);
    const deps = { search: searching({}), anilistMedia: noAnilist };
    assert.equal(
      await deriveTmdb(
        {
          anilistId: 51,
          year: 2026,
          format: 'TV',
          relations: [prequel(50, 'MOVIE')],
        },
        'tv',
        deps
      ),
      undefined
    );
    assert.equal(
      await deriveTmdb(
        {
          anilistId: 61,
          year: 2026,
          format: 'MOVIE',
          relations: [prequel(60)],
        },
        'movie',
        deps
      ),
      undefined
    );
  });

  it('asks AniList only when the caller had no relations, then retries its titles', async () => {
    const asked: number[] = [];
    const search = searching({
      'Simkl Spelling': [],
      本当の題名: [hit({ id: 777, originalName: '本当の題名', year: 2026 })],
    });
    const derived = await deriveTmdb(
      { anilistId: 9, titles: ['Simkl Spelling'], year: 2026 },
      'tv',
      {
        search,
        anilistMedia: async (id) => {
          asked.push(id);
          return {
            id,
            format: 'TV',
            title: { native: '本当の題名', romaji: 'Simkl Spelling' },
            startDate: { year: 2026 },
            relations: { edges: [] },
          };
        },
      }
    );
    assert.equal(derived?.tmdbId, 777);
    assert.deepEqual(asked, [9]);
    // The romaji spelling was already tried and is not searched twice.
    assert.deepEqual(search.asked, ['Simkl Spelling', '本当の題名']);
  });

  it("searches the caller's titles once AniList supplies the missing year", async () => {
    const search = searching({
      'Some Title': [hit({ id: 55, name: 'Some Title', year: 2026 })],
    });
    const derived = await deriveTmdb(
      { anilistId: 9, titles: ['Some Title'] },
      'tv',
      {
        search,
        anilistMedia: async (id) => ({
          id,
          format: 'TV',
          title: { romaji: 'Some Title' },
          startDate: { year: 2026 },
          relations: { edges: [] },
        }),
      }
    );
    assert.equal(derived?.tmdbId, 55);
    assert.deepEqual(search.asked, ['Some Title']);
  });

  it('lets an AniList failure through instead of guessing without relations', async () => {
    await assert.rejects(
      deriveTmdb({ anilistId: 9, titles: [], year: 2026 }, 'tv', {
        search: searching({}),
        anilistMedia: async () => {
          throw new Error('AniList API rate limited; retry after 30s');
        },
      }),
      /rate limited/
    );
  });

  it('stops walking after a bounded number of AniList requests', async () => {
    let requests = 0;
    const derived = await deriveTmdb(
      { anilistId: 1000, year: 2026, format: 'TV', relations: [prequel(1001)] },
      'tv',
      {
        search: searching({}),
        anilistMedia: async (id) => {
          requests += 1;
          return {
            id,
            relations: { edges: [prequel(id + 1)] },
          } as AnilistMedia;
        },
      }
    );
    assert.equal(derived, undefined);
    assert.equal(requests, 3);
  });
});
