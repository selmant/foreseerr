/* eslint-disable no-relative-import-paths/no-relative-import-paths */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  handleLibraryPlayClick,
  shouldNavigatePlayFallback,
} from '../../src/components/Library/libraryPlayAction';

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

  it('navigates after an async inspector lookup when native play is denied', () => {
    assert.equal(
      shouldNavigatePlayFallback(false, true, target.fallbackUrl),
      true
    );
    assert.equal(
      shouldNavigatePlayFallback(true, true, target.fallbackUrl),
      false
    );
    assert.equal(
      shouldNavigatePlayFallback(false, false, target.fallbackUrl),
      false
    );
    assert.equal(shouldNavigatePlayFallback(false, true, ''), false);
  });

  it('makes overview Play an ordinary-browser anchor', () => {
    const source = readFileSync(
      join(__dirname, '../../src/components/Library/LibraryPosterCard.tsx'),
      'utf8'
    );
    assert.match(source, /as="a"/);
    assert.match(source, /href=\{item\.mediaUrl\}/);
    assert.match(source, /data-testid="library-overview-play"/);
    assert.doesNotMatch(
      source,
      /event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*void playItem/
    );
  });
});
