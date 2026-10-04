import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { filterReleaseResults } from './releaseResults';
import type { Release } from './servarrTypes';

const release = (token: string, overrides: Partial<Release> = {}): Release => ({
  token,
  title: `Series.${token}`,
  quality: '1080p',
  size: 100,
  ageHours: 5,
  indexer: 'Example',
  protocol: 'torrent',
  rejections: [],
  rejected: false,
  downloadAllowed: true,
  ...overrides,
});

describe('release result comparison', () => {
  it('keeps service order and does not mutate the supplied releases', () => {
    const results = [release('b', { size: 200 }), release('a')];
    assert.deepEqual(
      filterReleaseResults(results, '', false, 'default').map((r) => r.token),
      ['b', 'a']
    );
    assert.deepEqual(
      filterReleaseResults(results, '', false, 'smallest').map((r) => r.token),
      ['a', 'b']
    );
    assert.equal(results[0].token, 'b');
  });
  it('searches title, quality, indexer and protocol without case sensitivity', () => {
    const results = [
      release('a', { quality: '2160p', indexer: 'Media Index' }),
      release('b'),
    ];
    assert.equal(
      filterReleaseResults(results, '  MEDIA INDEX  ', false, 'default')[0]
        .token,
      'a'
    );
    assert.equal(
      filterReleaseResults(results, '2160p', false, 'default').length,
      1
    );
    assert.equal(
      filterReleaseResults(results, 'TORRENT', false, 'default').length,
      2
    );
    assert.equal(
      filterReleaseResults(results, 'series.a', false, 'default').length,
      1
    );
  });
  it('shows only allowed downloads without rejections when ready is selected', () => {
    const results = [
      release('ready'),
      release('rejected', { rejected: true }),
      release('blocked', { downloadAllowed: false }),
    ];
    assert.deepEqual(
      filterReleaseResults(results, '', true, 'default').map((r) => r.token),
      ['ready']
    );
    assert.equal(filterReleaseResults(results, '', false, 'default').length, 3);
  });
  it('sorts by age or seeders, keeping unknown seeder counts last', () => {
    const results = [
      release('unknown'),
      release('old', { seeders: 10, ageHours: 10 }),
      release('new', { seeders: 0, ageHours: 1 }),
    ];
    assert.deepEqual(
      filterReleaseResults(results, '', false, 'newest').map((r) => r.token),
      ['new', 'unknown', 'old']
    );
    assert.deepEqual(
      filterReleaseResults(results, '', false, 'seeders').map((r) => r.token),
      ['old', 'new', 'unknown']
    );
  });
});
