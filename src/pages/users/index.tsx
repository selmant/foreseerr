import UserList from '@app/components/UserList';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';

const UsersPage = () => {
  useRouteGuard(Permission.MANAGE_USERS);
  return <UserList />;
};

export default UsersPage;
