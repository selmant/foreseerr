import { IssueStatus, IssueTypeName } from '@server/constants/issue';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { getIntl } from '@server/i18n';
import globalMessages from '@server/i18n/globalMessages';
import { requestNotificationStatus } from '@server/lib/notifications/requestStatus';
import type { NotificationAgentPushbullet } from '@server/lib/settings';
import { NotificationAgentKey, getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { AvailableLocale } from '@server/types/languages';
import axios from 'axios';
import {
  Notification,
  hasNotificationType,
  shouldSendAdminNotification,
} from '..';
import type { NotificationAgent, NotificationPayload } from './agent';
import { BaseAgent } from './agent';

interface PushbulletPayload {
  type: string;
  title: string;
  body: string;
  channel_tag?: string;
  url?: string;
}

class PushbulletAgent
  extends BaseAgent<NotificationAgentPushbullet>
  implements NotificationAgent
{
  protected getSettings(): NotificationAgentPushbullet {
    if (this.settings) {
      return this.settings;
    }

    const settings = getSettings();

    return settings.notifications.agents.pushbullet;
  }

  public shouldSend(): boolean {
    return true;
  }

  private getNotificationPayload(
    type: Notification,
    payload: NotificationPayload,
    locale?: AvailableLocale
  ): PushbulletPayload {
    const intl = getIntl(locale);
    const title = payload.event
      ? `${payload.event} - ${payload.subject}`
      : payload.subject;
    let body = payload.message ?? '';

    if (payload.request) {
      body += `\n\n${intl.formatMessage(globalMessages.requestedBy)}: ${payload.request.requestedBy.displayName}`;

      const status = requestNotificationStatus(type, payload, intl);

      if (status) {
        body += `\n${intl.formatMessage(globalMessages.requestStatus)}: ${status}`;
      }
    } else if (payload.comment) {
      body += `\n\n${intl.formatMessage(globalMessages.commentFrom, { userName: payload.comment.user.displayName })}:\n${payload.comment.message}`;
    } else if (payload.issue) {
      body += `\n\n${intl.formatMessage(globalMessages.reportedBy)}: ${payload.issue.createdBy.displayName}`;
      body += `\n${intl.formatMessage(globalMessages.issueType)}: ${IssueTypeName[payload.issue.issueType]}`;
      body += `\n${intl.formatMessage(globalMessages.issueStatus)}: ${
        payload.issue.status === IssueStatus.OPEN
          ? intl.formatMessage(globalMessages.open)
          : intl.formatMessage(globalMessages.resolved)
      }`;
    }

    for (const extra of payload.extra ?? []) {
      body += `\n${extra.name}: ${extra.value}`;
    }

    const url = payload.watchUrl;
    return {
      type: url ? 'link' : 'note',
      title,
      body,
      url,
    };
  }

  public async send(
    type: Notification,
    payload: NotificationPayload
  ): Promise<boolean> {
    const settings = this.getSettings();
    const endpoint = 'https://api.pushbullet.com/v2/pushes';

    // Send system notification
    if (
      payload.notifySystem &&
      hasNotificationType(type, settings.types ?? 0) &&
      settings.enabled &&
      settings.options.accessToken
    ) {
      logger.debug('Sending Pushbullet notification', {
        label: 'Notifications',
        type: Notification[type],
        subject: payload.subject,
      });

      try {
        const notificationPayload = this.getNotificationPayload(type, payload);

        await axios.post(
          endpoint,
          { ...notificationPayload, channel_tag: settings.options.channelTag },
          {
            headers: {
              'Access-Token': settings.options.accessToken,
            },
          }
        );
      } catch (e) {
        logger.error('Error sending Pushbullet notification', {
          label: 'Notifications',
          type: Notification[type],
          subject: payload.subject,
          errorMessage: e.message,
          response: e.response?.data,
        });

        return false;
      }
    }

    if (payload.notifyUser) {
      if (
        payload.notifyUser.settings?.hasNotificationType(
          NotificationAgentKey.PUSHBULLET,
          type
        ) &&
        payload.notifyUser.settings?.pushbulletAccessToken &&
        payload.notifyUser.settings.pushbulletAccessToken !==
          settings.options.accessToken
      ) {
        logger.debug('Sending Pushbullet notification', {
          label: 'Notifications',
          recipient: payload.notifyUser.displayName,
          type: Notification[type],
          subject: payload.subject,
        });

        try {
          const notificationPayload = this.getNotificationPayload(
            type,
            payload,
            payload.notifyUser.settings?.locale as AvailableLocale
          );

          await axios.post(endpoint, notificationPayload, {
            headers: {
              'Access-Token': payload.notifyUser.settings.pushbulletAccessToken,
            },
          });
        } catch (e) {
          logger.error('Error sending Pushbullet notification', {
            label: 'Notifications',
            recipient: payload.notifyUser.displayName,
            type: Notification[type],
            subject: payload.subject,
            errorMessage: e.message,
            response: e.response?.data,
          });

          return false;
        }
      }
    }

    if (payload.notifyAdmin) {
      const userRepository = getRepository(User);
      const users = await userRepository.find();

      await Promise.all(
        users
          .filter(
            (user) =>
              user.settings?.hasNotificationType(
                NotificationAgentKey.PUSHBULLET,
                type
              ) && shouldSendAdminNotification(type, user, payload)
          )
          .map(async (user) => {
            if (
              user.settings?.pushbulletAccessToken &&
              (settings.options.channelTag ||
                user.settings.pushbulletAccessToken !==
                  settings.options.accessToken)
            ) {
              logger.debug('Sending Pushbullet notification', {
                label: 'Notifications',
                recipient: user.displayName,
                type: Notification[type],
                subject: payload.subject,
              });

              try {
                const notificationPayload = this.getNotificationPayload(
                  type,
                  payload,
                  user.settings?.locale as AvailableLocale
                );

                await axios.post(endpoint, notificationPayload, {
                  headers: {
                    'Access-Token': user.settings.pushbulletAccessToken,
                  },
                });
              } catch (e) {
                logger.error('Error sending Pushbullet notification', {
                  label: 'Notifications',
                  recipient: user.displayName,
                  type: Notification[type],
                  subject: payload.subject,
                  errorMessage: e.message,
                  response: e.response?.data,
                });

                return false;
              }
            }
          })
      );
    }

    return true;
  }
}

export default PushbulletAgent;
