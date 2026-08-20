import type AnilistAPI from '@server/api/anilist';
import {
  AnilistNotLinkedError,
  createAnilistUserClient,
  getUserAnilistSettings,
} from '@server/lib/anilist';

/** The authenticated AniList client plus the remote account identity it owns. */
export interface AnilistUserContext {
  client: AnilistAPI;
  anilistUserId: number;
}

/**
 * Resolve linked AniList identity once and share the exact validation rule
 * between discovery, title actions, and episode-progress actions.
 */
export async function getAnilistUserContext(
  userId: number
): Promise<AnilistUserContext> {
  const client = await createAnilistUserClient(userId);
  const settings = await getUserAnilistSettings(userId);
  const anilistUserId = Number(settings?.anilistUserId);
  if (!Number.isFinite(anilistUserId) || anilistUserId <= 0) {
    throw new AnilistNotLinkedError();
  }
  return { client, anilistUserId };
}
