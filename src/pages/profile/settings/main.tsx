import UserSettings from '@app/components/UserProfile/UserSettings';
import UserGeneralSettings from '@app/components/UserProfile/UserSettings/UserGeneralSettings';

const UserSettingsMainPage = () => {
  return (
    <UserSettings>
      <UserGeneralSettings />
    </UserSettings>
  );
};

export default UserSettingsMainPage;
