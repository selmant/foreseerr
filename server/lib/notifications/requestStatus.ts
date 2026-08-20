import { MediaStatus } from '@server/constants/media';
import type { getIntl } from '@server/i18n';
import globalMessages from '@server/i18n/globalMessages';
import type { NotificationPayload } from './agents/agent';
import { Notification } from './index';

/** One canonical request-status mapping for notification transports. */
export function requestNotificationStatus(
  type: Notification,
  payload: NotificationPayload,
  intl: ReturnType<typeof getIntl>
): string | undefined {
  switch (type) {
    case Notification.MEDIA_AUTO_REQUESTED:
      return payload.media?.status === MediaStatus.PENDING
        ? intl.formatMessage(globalMessages.pendingApproval)
        : intl.formatMessage(globalMessages.processing);
    case Notification.MEDIA_PENDING:
      return intl.formatMessage(globalMessages.pendingApproval);
    case Notification.MEDIA_APPROVED:
    case Notification.MEDIA_AUTO_APPROVED:
      return intl.formatMessage(globalMessages.processing);
    case Notification.MEDIA_AVAILABLE:
      return intl.formatMessage(globalMessages.available);
    case Notification.MEDIA_DECLINED:
      return intl.formatMessage(globalMessages.declined);
    case Notification.MEDIA_FAILED:
      return intl.formatMessage(globalMessages.failed);
    default:
      return undefined;
  }
}
