/* eslint-disable no-relative-import-paths/no-relative-import-paths */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { handleLibraryPlayClick } from '../../src/components/Library/libraryPlayAction';

const target = {
  provider: 'jellyfin' as const,
  itemId: 'episode-1',
  fallbackUrl:
    'https://jellyfin.example.test/web/index.html#!/details?id=episode-1',
  label: 'Episode 1',
  quality: 'standard' as const,
};

describe('Library series playback links', () => {
  it('keeps the concrete anchor fallback in an ordinary browser', () => {
    let prevented = false;
    const admitted = handleLibraryPlayClick(
      { preventDefault: () => (prevented = true) },
      () => false,
      target
    );

    assert.equal(admitted, false);
    assert.equal(prevented, false);
  });

  it('intercepts the concrete anchor only after native play admission', () => {
    let prevented = false;
    const admitted = handleLibraryPlayClick(
      { preventDefault: () => (prevented = true) },
      () => true,
      target
    );

    assert.equal(admitted, true);
    assert.equal(prevented, true);
  });
});
