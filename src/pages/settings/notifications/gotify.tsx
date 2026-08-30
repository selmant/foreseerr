import NotificationsGotify from '@app/components/Settings/Notifications/NotificationsGotify';
import SettingsLayout from '@app/components/Settings/SettingsLayout';
import SettingsNotifications from '@app/components/Settings/SettingsNotifications';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';

const NotificationsPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsNotifications>
        <NotificationsGotify />
      </SettingsNotifications>
    </SettingsLayout>
  );
};

export default NotificationsPage;
