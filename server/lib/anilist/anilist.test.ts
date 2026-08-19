import AnilistAPI from '@server/api/anilist';
import {
  ANILIST_OAUTH_AUTHORIZE_URL,
  ANILIST_OAUTH_PIN_REDIRECT,
} from '@server/api/anilist/interfaces';
import {
  anilistFormatToMediaType,
  indexFribbEntries,
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
    const { byAnilist, byTmdb } = indexFribbEntries([
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
    assert.equal(byAnilist.size, 2);
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
