/* eslint-disable no-relative-import-paths/no-relative-import-paths */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  libraryWatchMark,
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

  it('uses remaining count whenever a series still has unplayed episodes', () => {
    assert.equal(
      libraryWatchMark({
        ...series,
        unplayedItemCount: 12,
        progressPercent: 40,
      }),
      'remaining'
    );
    assert.equal(
      libraryWatchMark({
        ...series,
        unplayedItemCount: 24,
      }),
      'remaining'
    );
  });

  it('marks a series with no remaining episodes as watched', () => {
    assert.equal(
      libraryWatchMark({ ...series, unplayedItemCount: 0 }),
      'watched'
    );
    assert.equal(libraryWatchMark({ ...series, watched: true }), 'watched');
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
