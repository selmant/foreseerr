import { refKey } from '@server/lib/mapping/types';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseGraphToken,
  parsePack,
  partitionPackRecord,
  splitRatio,
  validatePackBody,
} from './formats';
import { PackIndex } from './index';

describe('pack graph tokens', () => {
  it('parses anibridge descriptor and season-qualified target tokens', () => {
    assert.deepEqual(parseGraphToken('anidb:9541'), {
      ns: 'anidb',
      id: '9541',
    });
    assert.deepEqual(parseGraphToken('tmdb_show:1429:s1'), {
      ns: 'tmdb_show',
      id: '1429',
      season: 1,
    });
    // A trailing `:R` marks a release variant, not a season.
    assert.deepEqual(parseGraphToken('anidb:19242:R'), {
      ns: 'anidb',
      id: '19242',
    });
    assert.equal(parseGraphToken('nope:1'), undefined);
    assert.equal(parseGraphToken('anidb'), undefined);
  });

  it('splits the ratio suffix out of a range', () => {
    assert.deepEqual(splitRatio('1-13'), { range: '1-13', ratio: 1 });
    assert.deepEqual(splitRatio('14-|2'), { range: '14-', ratio: 2 });
  });
});

describe('json-graph pack format', () => {
  const ANIBRIDGE = JSON.stringify({
    'anidb:9541': {
      'anilist:16498': { '1-25': '1-25' },
      'tmdb_show:1429:s1': { '1-25': '1-25' },
      'tvdb_show:267440:s1': { '1-25': '1-25' },
    },
    'anidb:19242:R': {
      'tmdb_show:65942:s1': { '1-15': '67-81' },
    },
    'anidb:15449:R': {
      'tmdb_show:30984:s2': { '1-13': '1-13' },
    },
  });

  it('links every target token into one record', async () => {
    const { records } = await parsePack('json-graph', ANIBRIDGE);
    assert.equal(records.length, 3);
    const aot = records[0];
    assert.deepEqual(aot.refs.map(refKey), [
      'anidb:9541',
      'anilist:16498',
      'tmdb_show:1429:s1',
      'tvdb_show:267440:s1',
    ]);
  });

  it('captures absolute-numbering episode ranges', async () => {
    const { records } = await parsePack('json-graph', ANIBRIDGE);
    const rezero = records.find((record) =>
      record.refs.some((ref) => ref.id === '19242')
    );
    assert.ok(rezero);
    assert.deepEqual(rezero.episodeRules, [
      {
        source: { ns: 'anidb', id: '19242' },
        target: { ns: 'tmdb_show', id: '65942', season: 1 },
        sourceRange: '1-15',
        targetRange: '67-81',
        ratio: 1,
      },
    ]);
  });

  it('accepts a manifest-declared namespace alias', async () => {
    const { records } = await parsePack(
      'json-graph',
      JSON.stringify({ 'ani:1': { 'themoviedb:99': {} } }),
      { namespaceMap: { ani: 'anilist', themoviedb: 'tmdb_show' } }
    );
    assert.deepEqual(records[0].refs.map(refKey), [
      'anilist:1',
      'tmdb_show:99',
    ]);
  });
});

describe('json-array pack format', () => {
  it('maps declared fields onto namespaces', async () => {
    const { records } = await parsePack(
      'json-array',
      JSON.stringify([
        {
          anidb_id: 9541,
          anilist_id: 16498,
          mal_id: 16498,
          thetvdb_id: 267440,
          themoviedb_id: { tv: 1429 },
        },
        { anilist_id: 164, themoviedb_id: { movie: [128] } },
        { anilist_id: 0 },
      ]),
      {
        fieldMap: {
          anidb: 'anidb_id',
          anilist: 'anilist_id',
          mal: 'mal_id',
          tvdb_show: 'thetvdb_id',
          tmdb_show: 'themoviedb_id',
        },
      }
    );
    assert.equal(records.length, 2);
    assert.ok(records[0].refs.some((ref) => refKey(ref) === 'tmdb_show:1429'));
    // A nested `{ tv, movie }` field yields the correct TMDB namespace.
    assert.ok(records[1].refs.some((ref) => refKey(ref) === 'tmdb_movie:128'));
  });

  it('drops records that name only one namespace', async () => {
    const { records } = await parsePack(
      'json-array',
      JSON.stringify([{ anilist_id: 5 }]),
      { fieldMap: { anilist: 'anilist_id', mal: 'mal_id' } }
    );
    assert.equal(records.length, 0);
  });

  it('takes the media type from the row rather than assuming a show', async () => {
    const { records } = await parsePack(
      'json-array',
      JSON.stringify([
        { anilist: 1, themoviedb: 1429, themoviedb_type: 'tv' },
        { anilist: 2, themoviedb: 128, themoviedb_type: 'movie' },
        // No declared type: dropping the id is correct, because the same
        // integer names an unrelated title in the other catalogue.
        { anilist: 3, themoviedb: 999 },
      ]),
      {
        fieldMap: { anilist: 'anilist', tmdb_show: 'themoviedb' },
        typeFields: { themoviedb: 'themoviedb_type' },
      }
    );

    assert.deepEqual(records[0].refs.map(refKey), [
      'anilist:1',
      'tmdb_show:1429',
    ]);
    assert.deepEqual(records[1].refs.map(refKey), [
      'anilist:2',
      'tmdb_movie:128',
    ]);
    assert.equal(records.length, 2);
  });

  it('splits a nested tv+movie TMDB field into two works', async () => {
    const { records } = await parsePack(
      'json-array',
      JSON.stringify([
        {
          anilist_id: 21459,
          themoviedb_id: { tv: 65930, movie: 512200 },
        },
      ]),
      {
        fieldMap: {
          anilist: 'anilist_id',
          tmdb_show: 'themoviedb_id',
        },
      }
    );
    const [series, film] = partitionPackRecord(records[0]);
    assert.deepEqual(
      series.refs.map(refKey).sort(),
      ['anilist:21459', 'tmdb_show:65930'].sort()
    );
    assert.deepEqual(
      film.refs.map(refKey).sort(),
      ['anilist:21459', 'tmdb_movie:512200'].sort()
    );
  });

  it('keeps only the nested TMDB id that matches Fribb type', async () => {
    const { records } = await parsePack(
      'json-array',
      JSON.stringify([
        {
          type: 'TV',
          anilist_id: 21459,
          themoviedb_id: { tv: 65930, movie: 512200 },
        },
        {
          type: 'MOVIE',
          anilist_id: 21519,
          themoviedb_id: { tv: 999, movie: 372058 },
        },
      ]),
      {
        fieldMap: {
          anilist: 'anilist_id',
          tmdb_show: 'themoviedb_id',
        },
      }
    );
    assert.equal(records.length, 2);
    assert.deepEqual(records[0].refs.map(refKey).sort(), [
      'anilist:21459',
      'tmdb_show:65930',
    ]);
    assert.deepEqual(records[1].refs.map(refKey).sort(), [
      'anilist:21519',
      'tmdb_movie:372058',
    ]);
  });
});

describe('ndjson and yaml-map pack formats', () => {
  it('parses one record per line', async () => {
    const { records } = await parsePack(
      'ndjson',
      '{"a":1,"b":2}\n\n{"a":3,"b":4}\nnot json\n',
      { fieldMap: { anilist: 'a', mal: 'b' } }
    );
    assert.equal(records.length, 2);
    assert.deepEqual(records[1].refs.map(refKey), ['anilist:3', 'mal:4']);
  });

  it('parses a yaml mapping of records', async () => {
    const { records } = await parsePack(
      'yaml-map',
      'first:\n  a: 1\n  b: 2\nsecond:\n  a: 3\n  b: 4\n',
      { fieldMap: { anilist: 'a', mal: 'b' } }
    );
    assert.equal(records.length, 2);
  });
});

describe('xml-animelist pack format', () => {
  const XML = `<?xml version="1.0" encoding="UTF-8"?>
<anime-list>
  <anime anidbid="9541" tvdbid="267440" defaulttvdbseason="1" imdbid="tt2560140" tmdbid="1429">
    <name>Shingeki no Kyojin</name>
    <mapping-list>
      <mapping anidbseason="1" tvdbseason="1" start="1" end="25" offset="0"/>
      <mapping anidbseason="1" tvdbseason="4" start="1" end="16" offset="59"/>
    </mapping-list>
  </anime>
  <anime anidbid="1" tvdbid="unknown"/>
</anime-list>`;

  it('reads anidb, tvdb, imdb and tmdb ids with the default season', async () => {
    const { records } = await parsePack('xml-animelist', XML);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].refs.map(refKey), [
      'anidb:9541',
      'tvdb_show:267440:s1',
      'imdb:tt2560140',
      'tmdb_show:1429',
    ]);
    assert.equal(records[0].title, 'Shingeki no Kyojin');
  });

  it('stores a defaulttvdbseason=0 tmdb id as a movie', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<anime-list>
  <anime anidbid="10949" tvdbid="267440" defaulttvdbseason="0" tmdbid="372058" imdbid="tt5311514">
    <name>Kimi no Na wa.</name>
  </anime>
</anime-list>`;
    const { records } = await parsePack('xml-animelist', xml);
    assert.deepEqual(records[0].refs.map(refKey), [
      'anidb:10949',
      'imdb:tt5311514',
      'tmdb_movie:372058',
    ]);
  });

  it('turns mapping-list offsets into episode ranges', async () => {
    const { records } = await parsePack('xml-animelist', XML);
    assert.deepEqual(records[0].episodeRules?.[1], {
      source: { ns: 'anidb', id: '9541' },
      target: { ns: 'tvdb_show', id: '267440', season: 4 },
      sourceRange: '1-16',
      targetRange: '60-75',
      ratio: 1,
    });
  });
});

describe('pack validation rejects a truncated download', () => {
  it('rejects JSON cut mid-transfer', () => {
    assert.throws(() =>
      validatePackBody('json-graph', '{"anidb:1": {"tmdb_show:2": {')
    );
  });

  it('rejects an empty or entry-less JSON pack', () => {
    assert.throws(() => validatePackBody('json-array', '   '));
    assert.throws(() => validatePackBody('json-array', '[]'));
    assert.throws(() => validatePackBody('json-graph', '{}'));
  });

  it('rejects XML with no closing tag', () => {
    assert.throws(() =>
      validatePackBody('xml-animelist', '<anime-list><anime anidbid="1"/>')
    );
  });

  it('accepts a complete body of each format', () => {
    validatePackBody('json-graph', '{"anidb:1":{"tmdb_show:2":{}}}');
    validatePackBody('json-array', '[{"a":1}]');
    validatePackBody('ndjson', '{"a":1}\n{"a":2}');
    validatePackBody('yaml-map', 'a: 1\n');
    validatePackBody(
      'xml-animelist',
      '<anime-list><anime anidbid="1"/></anime-list>'
    );
  });

  it('parses an error envelope into zero mapping records', async () => {
    const { records } = await parsePack(
      'json-graph',
      JSON.stringify({ error: 'rate limited' })
    );
    assert.equal(records.length, 0);
  });
});

describe('season-scoped pack lookup', () => {
  it('does not answer a scoped query with a sibling-season record', () => {
    const index = new PackIndex([
      {
        refs: [
          { ns: 'anidb', id: '1', season: 1 },
          { ns: 'tmdb_show', id: '10', season: 1 },
        ],
      },
    ]);
    assert.equal(index.lookup({ ns: 'anidb', id: '1', season: 2 }).length, 0);
    assert.equal(index.lookup({ ns: 'anidb', id: '1', season: 1 }).length, 1);
  });
});
