import UserSettings from '@app/components/UserProfile/UserSettings';
import UserDiscoverSettings from '@app/components/UserProfile/UserSettings/UserDiscoverSettings';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';

const UserDiscoverSettingsPage = () => {
  useRouteGuard(Permission.MANAGE_USERS);
  return (
    <UserSettings>
      <UserDiscoverSettings />
    </UserSettings>
  );
};

export default UserDiscoverSettingsPage;
