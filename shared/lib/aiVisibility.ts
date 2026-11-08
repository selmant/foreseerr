import { MediaStatus } from '@shared/constants/media';
import type { AiPick } from '@shared/interfaces/api/aiInterfaces';
import type { PublicSettingsResponse } from '@shared/interfaces/api/settingsInterfaces';
import type { MovieResult, TvResult } from '@shared/models/Search';

export const visibleAiPicks = (
  picks: AiPick[],
  settings: Pick<
    PublicSettingsResponse,
    'hideAvailable' | 'hideRequested' | 'hideBlocklisted'
  >,
  canViewBlocklist: boolean
): AiPick[] =>
  picks.filter((pick) => {
    const info = (pick.item as unknown as MovieResult | TvResult).mediaInfo;
    if (
      info?.status === MediaStatus.BLOCKLISTED &&
      (!canViewBlocklist || settings.hideBlocklisted)
    )
      return false;
    if (
      settings.hideAvailable &&
      (info?.status === MediaStatus.AVAILABLE ||
        info?.status === MediaStatus.PARTIALLY_AVAILABLE)
    )
      return false;
    return !(settings.hideRequested && info?.hasActiveRequest);
  });
