import {
  TraktJellyfinProviderError,
  TraktNotConfiguredError,
  TraktNotLinkedError,
  isTraktUnavailableError,
  traktAvailabilityFromError,
} from '@server/lib/trakt';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('trakt availability errors', () => {
  it('treats missing config, unlinked accounts, and Jellyfin provider errors as unlinked', () => {
    assert.equal(isTraktUnavailableError(new TraktNotConfiguredError()), true);
    assert.equal(isTraktUnavailableError(new TraktNotLinkedError()), true);
    assert.equal(
      isTraktUnavailableError(new TraktJellyfinProviderError()),
      true
    );
    assert.equal(isTraktUnavailableError(new Error('network down')), false);
  });

  it('does not 500 capabilities when Better Trakt has no Jellyfin session', () => {
    assert.equal(
      traktAvailabilityFromError(new TraktJellyfinProviderError()),
      false
    );
    assert.throws(
      () => traktAvailabilityFromError(new Error('network down')),
      /network down/
    );
  });
});
