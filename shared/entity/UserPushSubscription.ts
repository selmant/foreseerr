import type { User } from '@shared/entity/User';

/** A browser Web Push subscription registered for a user. */
export interface UserPushSubscription {
  id: number;
  user: User;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string;
  createdAt: Date;
}
