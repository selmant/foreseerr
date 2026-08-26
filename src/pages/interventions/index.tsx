import ServarrInterventions from '@app/components/ServarrInterventions';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const InterventionsPage: NextPage = () => {
  useRouteGuard(Permission.MANAGE_REQUESTS);
  return <ServarrInterventions />;
};

export default InterventionsPage;
