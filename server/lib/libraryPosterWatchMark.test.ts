/* eslint-disable no-relative-import-paths/no-relative-import-paths */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  libraryMediaActionRefs,
  libraryWatchMark,
  overlayTitleActionWatched,
  showLibraryUnplayedPip,
} from '../../src/components/Library/libraryPosterWatchMark';

describe('libraryWatchMark', () => {
  it('marks titles with no play state as unplayed', () => {
    assert.equal(libraryWatchMark({}), 'unplayed');
    assert.equal(libraryWatchMark({ watched: false }), 'unplayed');
  });

  it('marks fully played titles as watched', () => {
    assert.equal(libraryWatchMark({ watched: true }), 'watched');
  });

  it('prefers in-progress over unplayed and watched for movies and episodes', () => {
    assert.equal(libraryWatchMark({ inProgress: true }), 'progress');
    assert.equal(libraryWatchMark({ progressPercent: 40 }), 'progress');
    assert.equal(
      libraryWatchMark({ watched: true, progressPercent: 40 }),
      'progress'
    );
  });

  const series = {
    mediaType: 'tv' as const,
    jellyfinItemId: 'series-1',
    jellyfinSeriesId: 'series-1',
  };

  it('marks a series as unplayed when every available episode is unplayed', () => {
    assert.equal(
      libraryWatchMark({
        ...series,
        availableEpisodeCount: 12,
        unplayedItemCount: 12,
      }),
      'unplayed'
    );
  });

  it('marks a series with some remaining episodes as partially watched', () => {
    assert.equal(
      libraryWatchMark({
        ...series,
        availableEpisodeCount: 24,
        unplayedItemCount: 12,
      }),
      'partial'
    );
  });

  it('marks in-progress Black Clover as partial from live Jellyfin counts', () => {
    assert.equal(
      libraryWatchMark({
        ...series,
        watched: false,
        availableEpisodeCount: 77,
        unplayedItemCount: 40,
      }),
      'partial'
    );
  });

  it('falls back to unplayed when RecursiveItemCount was not requested', () => {
    assert.equal(
      libraryWatchMark({
        ...series,
        watched: false,
        unplayedItemCount: 40,
      }),
      'unplayed'
    );
  });

  it('marks a series with no remaining available episodes as watched', () => {
    assert.equal(
      libraryWatchMark({
        ...series,
        availableEpisodeCount: 24,
        unplayedItemCount: 0,
      }),
      'watched'
    );
  });

  it('does not mistake an empty library series for a watched series', () => {
    assert.equal(
      libraryWatchMark({
        ...series,
        availableEpisodeCount: 0,
        unplayedItemCount: 0,
        watched: true,
      }),
      'unavailable'
    );
  });

  it('keeps episode rows on episode play state, not series remaining', () => {
    assert.equal(
      libraryWatchMark({
        mediaType: 'tv',
        jellyfinItemId: 'ep-1',
        jellyfinSeriesId: 'series-1',
        unplayedItemCount: 12,
      }),
      'unplayed'
    );
  });
});

describe('overlayTitleActionWatched', () => {
  it('applies title-level action watched only to movies', () => {
    assert.equal(overlayTitleActionWatched({ mediaType: 'movie' }), true);
    assert.equal(overlayTitleActionWatched({ mediaType: 'tv' }), false);
  });

  it('does not let a watched show paint an unwatched episode as watched', () => {
    const episode = {
      mediaType: 'tv' as const,
      jellyfinItemId: 'ep-1',
      jellyfinSeriesId: 'series-1',
      watched: false,
    };
    assert.equal(
      libraryWatchMark({
        ...episode,
        watched:
          Boolean(episode.watched) ||
          (overlayTitleActionWatched(episode) && true),
      }),
      'unplayed'
    );
  });
});

describe('showLibraryUnplayedPip', () => {
  it('shows for an unwatched title with no progress', () => {
    assert.equal(showLibraryUnplayedPip({}), true);
    assert.equal(showLibraryUnplayedPip({ watched: false }), true);
  });

  it('hides when watched', () => {
    assert.equal(showLibraryUnplayedPip({ watched: true }), false);
  });

  it('hides when in progress so the bar is the only mark', () => {
    assert.equal(showLibraryUnplayedPip({ inProgress: true }), false);
    assert.equal(showLibraryUnplayedPip({ progressPercent: 40 }), false);
  });
});

describe('libraryMediaActionRefs', () => {
  it('keeps titles with a tmdb id for any-provider watch status', () => {
    assert.deepEqual(
      libraryMediaActionRefs([
        { mediaType: 'movie', tmdbId: 1, title: 'Dune', year: 2021 },
        { mediaType: 'tv', title: 'No id' },
      ]),
      [{ mediaType: 'movie', tmdbId: 1, title: 'Dune', year: 2021 }]
    );
  });
});
