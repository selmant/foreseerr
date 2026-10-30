import type { MediaRequestStatus } from '@shared/constants/media';
import type { MediaRequest } from '@shared/entity/MediaRequest';

/** One requested season of a TV request. */
interface SeasonRequest {
  id: number;
  seasonNumber: number;
  status: MediaRequestStatus;
  /** Parent request; absent when nested inside that request. */
  request?: MediaRequest;
  createdAt: Date;
  updatedAt: Date;
}

export default SeasonRequest;
