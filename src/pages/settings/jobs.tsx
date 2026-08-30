import SettingsJobs from '@app/components/Settings/SettingsJobsCache';
import SettingsLayout from '@app/components/Settings/SettingsLayout';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';

const SettingsMainPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsJobs />
    </SettingsLayout>
  );
};

export default SettingsMainPage;
