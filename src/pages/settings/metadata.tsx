import SettingsLayout from '@app/components/Settings/SettingsLayout';
import SettingsMetadata from '@app/components/Settings/SettingsMetadata';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';

const MetadataSettingsPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsMetadata />
    </SettingsLayout>
  );
};

export default MetadataSettingsPage;
