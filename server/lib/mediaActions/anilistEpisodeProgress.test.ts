import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  absoluteEpisodeNumber,
  anilistProgressForEpisode,
  nextAnilistProgress,
  watchedEpisodeNumbersForSeason,
  watchedEpisodesFromProgress,
} from './anilistEpisodeProgress';

const twoSeasons = [
  { seasonNumber: 0, episodeCount: 4 },
  { seasonNumber: 1, episodeCount: 12 },
  { seasonNumber: 2, episodeCount: 10 },
];

describe('AniList episode progress mapping', () => {
  it('counts regular-season episodes and ignores specials', () => {
    assert.equal(absoluteEpisodeNumber(twoSeasons, 1, 3), 3);
    assert.equal(absoluteEpisodeNumber(twoSeasons, 2, 1), 13);
    assert.equal(absoluteEpisodeNumber(twoSeasons, 0, 1), null);
  });

  it('falls back to in-season numbering when AniList has a shorter cour', () => {
    assert.equal(anilistProgressForEpisode(13, 10, 1), 1);
    assert.equal(anilistProgressForEpisode(3, 12, 3), 3);
    assert.equal(anilistProgressForEpisode(24, 10, 14), null);
  });

  it('maps AniList progress back to the requested TMDB season', () => {
    assert.deepEqual(
      watchedEpisodeNumbersForSeason(twoSeasons, 1, 10, 22),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    );
    assert.deepEqual(
      watchedEpisodeNumbersForSeason(twoSeasons, 2, 15, 22),
      [1, 2, 3]
    );
    assert.deepEqual(
      watchedEpisodeNumbersForSeason(twoSeasons, 2, 4, 10),
      [1, 2, 3, 4]
    );
  });

  it('only rewinds AniList progress from the latest episode', () => {
    assert.equal(nextAnilistProgress(4, 10, true), 10);
    assert.equal(nextAnilistProgress(10, 10, true), null);
    assert.equal(nextAnilistProgress(10, 10, false), 9);
    assert.equal(nextAnilistProgress(10, 8, false), null);
  });

  it('maps AniList progress onto TMDB episode numbers with a cour offset', () => {
    assert.deepEqual(
      watchedEpisodesFromProgress(10, 25),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    );
    assert.deepEqual(
      watchedEpisodesFromProgress(5, 25, 13),
      [14, 15, 16, 17, 18]
    );
    assert.deepEqual(watchedEpisodesFromProgress(0, 25), []);
  });
});
