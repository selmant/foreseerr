import UserSettings from '@app/components/UserProfile/UserSettings';
import UserGeneralSettings from '@app/components/UserProfile/UserSettings/UserGeneralSettings';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';

const UserSettingsMainPage = () => {
  useRouteGuard(Permission.MANAGE_USERS);
  return (
    <UserSettings>
      <UserGeneralSettings />
    </UserSettings>
  );
};

export default UserSettingsMainPage;
