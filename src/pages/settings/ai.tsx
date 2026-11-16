import SettingsAi from '@app/components/Settings/SettingsAi';
import SettingsLayout from '@app/components/Settings/SettingsLayout';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';

const AiSettingsPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsAi />
    </SettingsLayout>
  );
};

export default AiSettingsPage;
