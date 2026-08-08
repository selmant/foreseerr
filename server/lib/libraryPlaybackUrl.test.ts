import { jellyfinPlaybackUrl } from '@server/lib/library';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('Jellyfin browser playback URLs', () => {
  it('uses the concrete resolved item instead of a Foreseer detail route', () => {
    assert.equal(
      jellyfinPlaybackUrl(
        'https://jellyfin.example.test/',
        'server id',
        'episode/id'
      ),
      'https://jellyfin.example.test/web/index.html#!/details?id=episode%2Fid&context=home&serverId=server%20id'
    );
  });
});
