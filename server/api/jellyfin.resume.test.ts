import type { JellyfinLibraryItemExtended } from '@server/api/jellyfin';
import { sortResumeItemsByDatePlayed } from '@server/api/jellyfin';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const item = (
  id: string,
  lastPlayedDate?: string
): JellyfinLibraryItemExtended =>
  ({
    Id: id,
    Name: id,
    Type: 'Episode',
    UserData: lastPlayedDate ? { LastPlayedDate: lastPlayedDate } : {},
  }) as JellyfinLibraryItemExtended;

describe('sortResumeItemsByDatePlayed', () => {
  it('puts the most recently played item first', () => {
    const sorted = sortResumeItemsByDatePlayed([
      item('old', '2026-08-10T12:00:00Z'),
      item('older', '2026-08-01T12:00:00Z'),
      item('newest', '2026-08-17T18:00:00Z'),
    ]);
    assert.deepEqual(
      sorted.map((entry) => entry.Id),
      ['newest', 'old', 'older']
    );
  });

  it('does not boost items that have no LastPlayedDate', () => {
    const sorted = sortResumeItemsByDatePlayed([
      item('no-date'),
      item('newest', '2026-08-17T18:00:00Z'),
      item('older', '2026-08-10T12:00:00Z'),
    ]);
    assert.deepEqual(
      sorted.map((entry) => entry.Id),
      ['newest', 'older', 'no-date']
    );
  });

  it('puts a dated item ahead of Jellyfin null-LastPlayedDate resume rows', () => {
    const sorted = sortResumeItemsByDatePlayed([
      item('Spartacus'),
      item('Hellraiser'),
      item('Moving', '2026-08-17T14:59:39.9072646Z'),
    ]);
    assert.deepEqual(
      sorted.map((entry) => entry.Id),
      ['Moving', 'Spartacus', 'Hellraiser']
    );
  });
});
