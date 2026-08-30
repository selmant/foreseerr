import UserSettings from '@app/components/UserProfile/UserSettings';
import UserLinkedAccountsSettings from '@app/components/UserProfile/UserSettings/UserLinkedAccountsSettings';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';

const UserLinkedAccountsPage = () => {
  useRouteGuard(Permission.MANAGE_USERS);
  return (
    <UserSettings>
      <UserLinkedAccountsSettings />
    </UserSettings>
  );
};

export default UserLinkedAccountsPage;
