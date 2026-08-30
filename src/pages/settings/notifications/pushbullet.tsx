import NotificationsPushbullet from '@app/components/Settings/Notifications/NotificationsPushbullet';
import SettingsLayout from '@app/components/Settings/SettingsLayout';
import SettingsNotifications from '@app/components/Settings/SettingsNotifications';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';

const NotificationsPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsNotifications>
        <NotificationsPushbullet />
      </SettingsNotifications>
    </SettingsLayout>
  );
};

export default NotificationsPage;
