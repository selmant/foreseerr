/* eslint-disable no-relative-import-paths/no-relative-import-paths */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { showLibraryUnplayedPip } from '../../src/components/Library/libraryPosterWatchMark';

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
