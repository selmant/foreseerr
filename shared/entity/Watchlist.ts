import type { MediaType } from '@shared/constants/media';
import type Media from '@shared/entity/Media';
import type { User } from '@shared/entity/User';

/** A title on a user's local watchlist. */
export interface Watchlist {
  id: number;
  ratingKey: string;
  mediaType: MediaType;
  title: string;
  tmdbId: number;
  requestedBy: User;
  media: Media;
  createdAt: Date;
  updatedAt: Date;
}
