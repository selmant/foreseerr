import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MediaStatus } from '@shared/constants/media';
import type { AiPick } from '@shared/interfaces/api/aiInterfaces';
import { visibleAiPicks } from './aiVisibility';
const pick = (
  status: MediaStatus,
  hasActiveRequest = false,
  status4k = MediaStatus.UNKNOWN
) =>
  ({
    tmdbId: status,
    mediaType: 'movie',
    item: { mediaInfo: { status, status4k, hasActiveRequest } },
  }) as unknown as AiPick;
const settings = {
  hideAvailable: false,
  hideRequested: false,
  hideBlocklisted: false,
};
describe('AI recommendation visibility', () => {
  it('always hides blocklisted titles without blocklist permissions', () => {
    const picks = [pick(MediaStatus.AVAILABLE), pick(MediaStatus.BLOCKLISTED)];
    assert.equal(visibleAiPicks(picks, settings, false).length, 1);
    assert.equal(visibleAiPicks(picks, settings, true).length, 2);
    assert.equal(
      visibleAiPicks(picks, { ...settings, hideBlocklisted: true }, true)
        .length,
      1
    );
  });
  it('honors available, partially available and requested hiding settings', () => {
    const picks = [
      pick(MediaStatus.AVAILABLE),
      pick(MediaStatus.PARTIALLY_AVAILABLE),
      pick(MediaStatus.PENDING, true),
      pick(MediaStatus.UNKNOWN),
    ];
    assert.deepEqual(
      visibleAiPicks(
        picks,
        { ...settings, hideAvailable: true, hideRequested: true },
        true
      ).map((p) => p.tmdbId),
      [MediaStatus.UNKNOWN]
    );
  });
  it('hides titles available only in 4K', () => {
    const only4k = pick(MediaStatus.UNKNOWN, false, MediaStatus.AVAILABLE);
    assert.equal(
      visibleAiPicks([only4k], { ...settings, hideAvailable: true }, true)
        .length,
      0
    );
  });
  it('keeps available titles for library-only runs', () => {
    const picks = [pick(MediaStatus.AVAILABLE), pick(MediaStatus.BLOCKLISTED)];
    assert.equal(
      visibleAiPicks(
        picks,
        { ...settings, hideAvailable: true },
        false,
        'library'
      ).length,
      1
    );
  });
});
