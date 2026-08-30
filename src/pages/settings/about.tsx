import SettingsAbout from '@app/components/Settings/SettingsAbout';
import SettingsLayout from '@app/components/Settings/SettingsLayout';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';

const SettingsAboutPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsAbout />
    </SettingsLayout>
  );
};

export default SettingsAboutPage;
