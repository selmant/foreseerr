import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseAnibridge, parseFribb } from './parsers';

describe('anibridge dataset', () => {
  it('turns each range pair into one directed edge', () => {
    const { edges, version } = parseAnibridge(
      JSON.stringify({
        $meta: { generated_on: '2026-09-26T06:57:14Z' },
        'anilist:1225': {
          'tmdb_show:62913:s2': { '1-3': '1-3' },
          'anidb:3:R': { '1-3': '1-3' },
        },
      })
    );
    assert.equal(version, '2026-09-26T06:57:14Z');
    assert.deepEqual(edges[0], {
      srcNs: 'anilist',
      srcId: '1225',
      srcScope: '',
      dstNs: 'tmdb_show',
      dstId: '62913',
      dstScope: 's2',
      srcRange: '1-3',
      dstRange: '1-3',
    });
    assert.equal(edges[1].dstScope, 'R');
  });

  it('keeps IMDb edges, whichever IMDb provider the file names', () => {
    const { edges } = parseAnibridge(
      JSON.stringify({
        'anilist:5': { 'imdb_movie:tt0275277': { '1': '1' } },
        'imdb_show:tt0213338:s1': { 'anilist:1': { '1-26': '1-26' } },
      })
    );
    assert.deepEqual(
      edges.map((edge) => `${edge.srcNs}:${edge.srcId}>${edge.dstNs}`),
      ['anilist:5>imdb', 'imdb:tt0213338>anilist']
    );
  });

  it('skips providers it does not know instead of failing', () => {
    const { edges } = parseAnibridge(
      JSON.stringify({
        'anilist:1': { 'kitsu:1': {}, 'mal:1': {} },
        'kitsu:1': { 'anilist:1': {} },
      })
    );
    assert.equal(edges.length, 1);
    assert.equal(edges[0].dstNs, 'mal');
    assert.equal(edges[0].srcRange, undefined);
  });

  it('rejects a body that is not the expected object', () => {
    assert.throws(() => parseAnibridge('[]'));
    assert.throws(() => parseAnibridge('{"anilist:1": {'));
  });
});

describe('fribb dataset', () => {
  const targets = (row: Record<string, unknown>): string[] =>
    parseFribb(JSON.stringify([row]))
      .edges.filter((edge) => edge.srcNs === 'anilist')
      .map(
        (edge) =>
          `${edge.dstNs}:${edge.dstId}${edge.dstScope ? `:${edge.dstScope}` : ''}`
      );

  it('maps a series entry to its show and season, never to the films', () => {
    assert.deepEqual(
      targets({
        type: 'TV',
        anilist_id: 290,
        themoviedb_id: { tv: 26209, movie: [319145] },
        tvdb_id: 72025,
        season: { tvdb: 1, tmdb: 1 },
      }),
      ['tmdb_show:26209:s1', 'tvdb_show:72025:s1']
    );
  });

  it('maps a film entry to its single film', () => {
    assert.deepEqual(
      targets({
        type: 'MOVIE',
        anilist_id: 5661,
        themoviedb_id: { tv: 99, movie: [319145] },
        imdb_id: ['tt0419229'],
      }),
      ['tmdb_movie:319145', 'imdb:tt0419229']
    );
  });

  it('gives no film answer when an entry lists several', () => {
    assert.deepEqual(
      targets({
        type: 'MOVIE',
        anilist_id: 821,
        themoviedb_id: { movie: [19263, 34384] },
      }),
      []
    );
  });

  it('states a range only when the row carries an offset, in both directions', () => {
    const { edges } = parseFribb(
      JSON.stringify([
        {
          type: 'TV',
          anilist_id: 190,
          themoviedb_id: { tv: 30992 },
          season: { tmdb: 1 },
          episode_offset: { tmdb: 12 },
        },
      ])
    );
    assert.deepEqual(
      edges.map((edge) => [edge.srcNs, edge.srcRange, edge.dstRange]),
      [
        ['anilist', '1-', '13-'],
        ['tmdb_show', '13-', '1-'],
      ]
    );
  });

  it('files an AniDB id under its regular-episode scope', () => {
    const { edges } = parseFribb(
      JSON.stringify([{ type: 'TV', anidb_id: 1, themoviedb_id: { tv: 5 } }])
    );
    assert.equal(edges[0].srcScope, 'R');
  });
});
