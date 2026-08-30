import UserSettings from '@app/components/UserProfile/UserSettings';
import UserNotificationSettings from '@app/components/UserProfile/UserSettings/UserNotificationSettings';
import UserNotificationsEmail from '@app/components/UserProfile/UserSettings/UserNotificationSettings/UserNotificationsEmail';

const NotificationsPage = () => {
  return (
    <UserSettings>
      <UserNotificationSettings>
        <UserNotificationsEmail />
      </UserNotificationSettings>
    </UserSettings>
  );
};

export default NotificationsPage;
