import UserSettings from '@app/components/UserProfile/UserSettings';
import UserNotificationSettings from '@app/components/UserProfile/UserSettings/UserNotificationSettings';
import UserNotificationsTelegram from '@app/components/UserProfile/UserSettings/UserNotificationSettings/UserNotificationsTelegram';

const NotificationsPage = () => {
  return (
    <UserSettings>
      <UserNotificationSettings>
        <UserNotificationsTelegram />
      </UserNotificationSettings>
    </UserSettings>
  );
};

export default NotificationsPage;
