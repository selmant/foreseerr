import UserSettings from '@app/components/UserProfile/UserSettings';
import UserNotificationSettings from '@app/components/UserProfile/UserSettings/UserNotificationSettings';
import UserNotificationsEmail from '@app/components/UserProfile/UserSettings/UserNotificationSettings/UserNotificationsEmail';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';

const NotificationsPage = () => {
  useRouteGuard(Permission.MANAGE_USERS);
  return (
    <UserSettings>
      <UserNotificationSettings>
        <UserNotificationsEmail />
      </UserNotificationSettings>
    </UserSettings>
  );
};

export default NotificationsPage;
