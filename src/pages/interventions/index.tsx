import ServarrInterventions from '@app/components/ServarrInterventions';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';

const InterventionsPage = () => {
  useRouteGuard(Permission.MANAGE_REQUESTS);
  return <ServarrInterventions />;
};

export default InterventionsPage;
