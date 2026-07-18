import SettingsLayout from '@app/components/Settings/SettingsLayout';
import SettingsRequestFilters from '@app/components/Settings/SettingsRequestFilters';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const RequestFiltersSettingsPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsRequestFilters />
    </SettingsLayout>
  );
};

export default RequestFiltersSettingsPage;
