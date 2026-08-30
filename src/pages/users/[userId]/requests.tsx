import RequestList from '@app/components/RequestList';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';

const UserRequestsPage = () => {
  useRouteGuard([Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW], {
    type: 'or',
  });
  return <RequestList />;
};

export default UserRequestsPage;
