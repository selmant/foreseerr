import UserSettings from '@app/components/UserProfile/UserSettings';
import UserNotificationSettings from '@app/components/UserProfile/UserSettings/UserNotificationSettings';
import UserNotificationsPushover from '@app/components/UserProfile/UserSettings/UserNotificationSettings/UserNotificationsPushover';

const NotificationsPage = () => {
  return (
    <UserSettings>
      <UserNotificationSettings>
        <UserNotificationsPushover />
      </UserNotificationSettings>
    </UserSettings>
  );
};

export default NotificationsPage;
