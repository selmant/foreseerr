import NotificationsSlack from '@app/components/Settings/Notifications/NotificationsSlack';
import SettingsLayout from '@app/components/Settings/SettingsLayout';
import SettingsNotifications from '@app/components/Settings/SettingsNotifications';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';

const NotificationsSlackPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsNotifications>
        <NotificationsSlack />
      </SettingsNotifications>
    </SettingsLayout>
  );
};

export default NotificationsSlackPage;
