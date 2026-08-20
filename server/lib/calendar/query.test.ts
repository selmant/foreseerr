import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCalendarQuery, safeExternalHttpUrl } from './query';

describe('calendar query parsing', () => {
  it('returns typed filters for the supported calendar controls', () => {
    const filters = parseCalendarQuery(
      {
        start: '2026-08-01',
        end: '2026-08-31',
        scope: 'all',
        mediaType: 'movie',
        source: 'radarr',
        serverId: '2',
        is4k: 'true',
        includeEpisodes: 'false',
        includeUnmonitored: 'true',
      },
      true
    );

    assert.deepEqual(
      {
        scope: filters.scope,
        mediaType: filters.mediaType,
        source: filters.source,
        serverId: filters.serverId,
        is4k: filters.is4k,
        includeEpisodes: filters.includeEpisodes,
        includeUnmonitored: filters.includeUnmonitored,
      },
      {
        scope: 'all',
        mediaType: 'movie',
        source: 'radarr',
        serverId: 2,
        is4k: true,
        includeEpisodes: false,
        includeUnmonitored: true,
      }
    );
  });

  it('rejects administrator-only filters for regular users', () => {
    assert.throws(
      () =>
        parseCalendarQuery(
          { start: '2026-08-01', end: '2026-08-31', serverId: '2' },
          false
        ),
      { message: /administrator permission/i }
    );
  });

  it('only returns safe external watch URLs', () => {
    assert.equal(
      safeExternalHttpUrl('https://media.example/watch'),
      'https://media.example/watch'
    );
    assert.equal(safeExternalHttpUrl('javascript:alert(1)'), undefined);
  });
});
