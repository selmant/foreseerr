import type { MediaType } from '@shared/constants/media';
import type Media from '@shared/entity/Media';
import type { User } from '@shared/entity/User';

/** A title hidden from Discover and blocked from requests. */
export interface Blocklist {
  id: number;
  mediaType: MediaType;
  title?: string;
  tmdbId: number;
  user?: User;
  media: Media;
  blocklistedTags?: string;
  createdAt: Date;
}
