import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// eslint-disable-next-line no-relative-import-paths/no-relative-import-paths
import {
  failedProviderLabels,
  hasMediaActionProviderError,
  isMediaActionMappingMissing,
  writeSucceeded,
} from '../../../src/utils/mediaActions';

const provider = (ok: boolean) => ({
  provider: 'trakt',
  ok,
  watched: ok,
  rating: null,
  ratingStars: null,
});

describe('client media-action write outcome handling', () => {
  it('distinguishes an unmatched catalog title from a provider outage', () => {
    assert.equal(
      isMediaActionMappingMissing('No Jellyfin mapping for item'),
      true
    );
    assert.equal(
      isMediaActionMappingMissing('No AniList mapping for item'),
      true
    );
    assert.equal(
      hasMediaActionProviderError([
        { ...provider(false), error: 'No Jellyfin mapping for item' },
      ]),
      false
    );
    assert.equal(
      hasMediaActionProviderError([
        provider(true),
        { ...provider(false), error: 'Service unavailable' },
      ]),
      true
    );
    assert.equal(hasMediaActionProviderError([provider(false)]), true);
    assert.equal(hasMediaActionProviderError([]), false);
  });
  it('accepts full and partial writes with an applied provider', () => {
    assert.equal(
      writeSucceeded({
        outcome: 'success',
        watched: true,
        providers: [provider(true)],
      }),
      true
    );
    assert.equal(
      writeSucceeded({
        outcome: 'partial',
        watched: true,
        providers: [
          provider(false),
          { ...provider(true), provider: 'jellyfin' },
        ],
      }),
      true
    );
  });

  it('rejects total failures and empty provider results', () => {
    assert.equal(
      writeSucceeded({
        outcome: 'failure',
        watched: false,
        providers: [provider(false)],
      }),
      false
    );
    assert.equal(
      writeSucceeded({ outcome: 'success', watched: true, providers: [] }),
      false
    );
  });

  it('names failed providers for partial episode toasts', () => {
    assert.equal(
      failedProviderLabels([
        { ...provider(true), provider: 'trakt' },
        { ...provider(false), provider: 'anilist' },
      ]),
      'AniList'
    );
  });
});
