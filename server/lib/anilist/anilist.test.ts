import AnilistAPI from '@server/api/anilist';
import {
  ANILIST_OAUTH_AUTHORIZE_URL,
  ANILIST_OAUTH_PIN_REDIRECT,
} from '@server/api/anilist/interfaces';
import {
  anilistFormatToMediaType,
  indexFribbEntries,
  pickFribbSeasonEntry,
  resolveFribbTmdb,
} from '@server/lib/anilist/mapping';
import {
  isAnilistWatchedStatus,
  providerRatingToScoreRaw,
  scoreRawToProvider,
} from '@server/lib/mediaActions/anilistSyncCache';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('AniList mapping', () => {
  it('maps MOVIE format to movie and other formats to tv', () => {
    assert.equal(anilistFormatToMediaType('MOVIE'), 'movie');
    assert.equal(anilistFormatToMediaType('TV'), 'tv');
    assert.equal(anilistFormatToMediaType('OVA'), 'tv');
  });

  it('prefers movie TMDB ids for movie entries and tv ids for series', () => {
    assert.deepEqual(resolveFribbTmdb({ movie: [128], tv: 99 }, 'MOVIE'), {
      tmdbId: 128,
      mediaType: 'movie',
    });
    assert.deepEqual(resolveFribbTmdb({ movie: [128], tv: 26209 }, 'TV'), {
      tmdbId: 26209,
      mediaType: 'tv',
    });
    assert.deepEqual(resolveFribbTmdb({ tv: 44298 }, 'MOVIE'), {
      tmdbId: 44298,
      mediaType: 'tv',
    });
  });

  it('indexes AniList ids in both directions from a Fribb fixture', () => {
    const { byAnilist, byTmdb, byTmdbAll } = indexFribbEntries([
      {
        type: 'MOVIE',
        anilist_id: 164,
        themoviedb_id: { movie: [128] },
      },
      {
        type: 'TV',
        anilist_id: 290,
        themoviedb_id: { tv: 26209 },
      },
      {
        type: 'TV',
        anilist_id: 0,
      },
    ]);

    assert.deepEqual(byAnilist.get(164), { tmdbId: 128, mediaType: 'movie' });
    assert.deepEqual(byAnilist.get(290), { tmdbId: 26209, mediaType: 'tv' });
    assert.equal(byTmdb.get('movie:128'), 164);
    assert.equal(byTmdb.get('tv:26209'), 290);
    assert.deepEqual(byTmdbAll.get('tv:26209'), [290]);
    assert.equal(byAnilist.size, 2);
  });

  it('keeps every AniList id that maps to the same TMDB show', () => {
    const { byTmdb, byTmdbAll } = indexFribbEntries([
      {
        type: 'TV',
        anilist_id: 21355,
        themoviedb_id: { tv: 65942 },
      },
      {
        type: 'OVA',
        anilist_id: 100049,
        themoviedb_id: { tv: 65942 },
      },
      {
        type: 'TV',
        anilist_id: 189046,
        themoviedb_id: { tv: 65942 },
      },
    ]);

    assert.equal(byTmdb.get('tv:65942'), 21355);
    assert.deepEqual(byTmdbAll.get('tv:65942'), [21355, 100049, 189046]);
  });

  it('uses Fribb TVDB seasons when TMDB seasons are collapsed to 1', () => {
    const { byTmdbSeasons } = indexFribbEntries([
      {
        type: 'TV',
        anilist_id: 21355,
        themoviedb_id: { tv: 65942 },
        season: { tvdb: 1, tmdb: 1 },
      },
      {
        type: 'OVA',
        anilist_id: 100049,
        themoviedb_id: { tv: 65942 },
        season: { tvdb: 0, tmdb: 0 },
      },
      {
        type: 'TV',
        anilist_id: 108632,
        themoviedb_id: { tv: 65942 },
        season: { tvdb: 2, tmdb: 1 },
        episode_offset: { tmdb: 26 },
      },
      {
        type: 'TV',
        anilist_id: 119661,
        themoviedb_id: { tv: 65942 },
        season: { tvdb: 2, tmdb: 1 },
        episode_offset: { tvdb: 13, tmdb: 38 },
      },
      {
        type: 'TV',
        anilist_id: 163134,
        themoviedb_id: { tv: 65942 },
        season: { tvdb: 3, tmdb: 1 },
        episode_offset: { tmdb: 50 },
      },
      {
        type: 'TV',
        anilist_id: 189046,
        themoviedb_id: { tv: 65942 },
        season: { tvdb: 4, tmdb: 1 },
        episode_offset: { tmdb: 66 },
      },
    ]);
    const entries = byTmdbSeasons.get('tv:65942') ?? [];

    assert.deepEqual(pickFribbSeasonEntry(entries, 4, 10), {
      mapping: {
        anilistId: 189046,
        type: 'TV',
        seasonTmdb: 1,
        seasonTvdb: 4,
        offsetTmdb: 66,
        offsetTvdb: 0,
      },
      progress: 10,
      mode: 'in-season',
    });
    assert.equal(
      pickFribbSeasonEntry(entries, 4, 10)?.mapping.anilistId,
      189046
    );
    assert.equal(pickFribbSeasonEntry(entries, 1, 3)?.mapping.anilistId, 21355);
    assert.equal(
      pickFribbSeasonEntry(entries, 3, 2)?.mapping.anilistId,
      163134
    );
    assert.equal(pickFribbSeasonEntry(entries, 5, 1), null);
  });

  it('picks TMDB season numbers when Fribb has distinct tmdb seasons', () => {
    const { byTmdbSeasons } = indexFribbEntries([
      {
        type: 'TV',
        anilist_id: 290,
        themoviedb_id: { tv: 26209 },
        season: { tvdb: 1, tmdb: 1 },
      },
      {
        type: 'TV',
        anilist_id: 396,
        themoviedb_id: { tv: 26209 },
        season: { tvdb: 2, tmdb: 2 },
      },
      {
        type: 'TV',
        anilist_id: 397,
        themoviedb_id: { tv: 26209 },
        season: { tvdb: 3, tmdb: 3 },
      },
    ]);
    const entries = byTmdbSeasons.get('tv:26209') ?? [];

    assert.equal(pickFribbSeasonEntry(entries, 2, 1)?.mapping.anilistId, 396);
    assert.equal(pickFribbSeasonEntry(entries, 2, 1)?.mode, 'in-season');
  });
});

describe('AniList score and watched mapping', () => {
  it('converts scoreRaw 0–100 to provider 1–10', () => {
    assert.equal(scoreRawToProvider(null), null);
    assert.equal(scoreRawToProvider(0), null);
    assert.equal(scoreRawToProvider(85), 9);
    assert.equal(scoreRawToProvider(100), 10);
    assert.equal(providerRatingToScoreRaw(8), 80);
  });

  it('treats COMPLETED and REPEATING as watched', () => {
    assert.equal(isAnilistWatchedStatus('COMPLETED'), true);
    assert.equal(isAnilistWatchedStatus('REPEATING'), true);
    assert.equal(isAnilistWatchedStatus('CURRENT'), false);
    assert.equal(isAnilistWatchedStatus('PLANNING'), false);
  });
});

describe('AniList OAuth helpers', () => {
  it('builds the PIN authorize URL', () => {
    const url = AnilistAPI.buildAuthorizeUrl('client-123');
    assert.ok(url.startsWith(ANILIST_OAUTH_AUTHORIZE_URL));
    assert.ok(url.includes('client_id=client-123'));
    assert.ok(
      url.includes(
        `redirect_uri=${encodeURIComponent(ANILIST_OAUTH_PIN_REDIRECT)}`
      )
    );
    assert.ok(url.includes('response_type=code'));
  });

  it('resolves the current AniList season from calendar month', () => {
    assert.deepEqual(AnilistAPI.currentSeason(new Date('2026-01-15')), {
      season: 'WINTER',
      year: 2026,
    });
    assert.deepEqual(AnilistAPI.currentSeason(new Date('2026-04-01')), {
      season: 'SPRING',
      year: 2026,
    });
    assert.deepEqual(AnilistAPI.currentSeason(new Date('2026-08-18')), {
      season: 'SUMMER',
      year: 2026,
    });
    assert.deepEqual(AnilistAPI.currentSeason(new Date('2026-11-02')), {
      season: 'FALL',
      year: 2026,
    });
  });

  it('resolves the next AniList season from the current one', () => {
    assert.deepEqual(AnilistAPI.nextSeason(new Date('2026-01-15')), {
      season: 'SPRING',
      year: 2026,
    });
    assert.deepEqual(AnilistAPI.nextSeason(new Date('2026-08-18')), {
      season: 'FALL',
      year: 2026,
    });
    assert.deepEqual(AnilistAPI.nextSeason(new Date('2026-11-02')), {
      season: 'WINTER',
      year: 2027,
    });
  });
});
