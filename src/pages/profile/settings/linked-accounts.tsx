import UserSettings from '@app/components/UserProfile/UserSettings';
import UserLinkedAccountsSettings from '@app/components/UserProfile/UserSettings/UserLinkedAccountsSettings';

const UserSettingsLinkedAccountsPage = () => {
  return (
    <UserSettings>
      <UserLinkedAccountsSettings />
    </UserSettings>
  );
};

export default UserSettingsLinkedAccountsPage;
