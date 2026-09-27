import { isAppRelease } from '@server/api/github';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('isAppRelease', () => {
  it('counts app tags and ignores Jellyfin plugin tags', () => {
    assert.equal(isAppRelease({ tag_name: 'v0.10.0' }), true);
    assert.equal(isAppRelease({ tag_name: 'v0.1.0-alpha.5' }), true);
    assert.equal(
      isAppRelease({ tag_name: 'jellyfin-plugin-v0.1.0-alpha.1' }),
      false
    );
  });
});
