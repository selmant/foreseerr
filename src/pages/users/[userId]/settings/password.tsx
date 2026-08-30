import UserSettings from '@app/components/UserProfile/UserSettings';
import UserPasswordChange from '@app/components/UserProfile/UserSettings/UserPasswordChange';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';

const UserPassswordPage = () => {
  useRouteGuard(Permission.MANAGE_USERS);
  return (
    <UserSettings>
      <UserPasswordChange />
    </UserSettings>
  );
};

export default UserPassswordPage;
