import IssueList from '@app/components/IssueList';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';

const IssuePage = () => {
  useRouteGuard(
    [
      Permission.MANAGE_ISSUES,
      Permission.CREATE_ISSUES,
      Permission.VIEW_ISSUES,
    ],
    {
      type: 'or',
    }
  );
  return <IssueList />;
};

export default IssuePage;
