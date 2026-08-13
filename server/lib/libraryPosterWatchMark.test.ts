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

  it('prefers in-progress over unplayed and watched', () => {
    assert.equal(libraryWatchMark({ inProgress: true }), 'progress');
    assert.equal(libraryWatchMark({ progressPercent: 40 }), 'progress');
    assert.equal(
      libraryWatchMark({ watched: true, progressPercent: 40 }),
      'progress'
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
