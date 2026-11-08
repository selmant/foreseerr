import { MediaStatus } from '@shared/constants/media';
import type {
  AiAvailability,
  AiPick,
} from '@shared/interfaces/api/aiInterfaces';
import type { PublicSettingsResponse } from '@shared/interfaces/api/settingsInterfaces';
import type { MovieResult, TvResult } from '@shared/models/Search';

const AVAILABLE = [MediaStatus.AVAILABLE, MediaStatus.PARTIALLY_AVAILABLE];

/**
 * The picks this person may see under the server's hiding settings.
 * `availability` is the run's filter: a library-only run shows available
 * titles even when `hideAvailable` is on, since that is what was asked for.
 */
export const visibleAiPicks = (
  picks: AiPick[],
  settings: Pick<
    PublicSettingsResponse,
    'hideAvailable' | 'hideRequested' | 'hideBlocklisted'
  >,
  canViewBlocklist: boolean,
  availability?: AiAvailability | null
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
      availability !== 'library' &&
      ((info?.status !== undefined && AVAILABLE.includes(info.status)) ||
        (info?.status4k !== undefined && AVAILABLE.includes(info.status4k)))
    )
      return false;
    return !(settings.hideRequested && info?.hasActiveRequest);
  });
