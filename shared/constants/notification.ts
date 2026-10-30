/** Notification event bitmasks shared by the server and browser UI. */
export enum Notification {
  NONE = 0,
  MEDIA_PENDING = 2,
  MEDIA_APPROVED = 4,
  MEDIA_AVAILABLE = 8,
  MEDIA_FAILED = 16,
  TEST_NOTIFICATION = 32,
  MEDIA_DECLINED = 64,
  MEDIA_AUTO_APPROVED = 128,
  ISSUE_CREATED = 256,
  ISSUE_COMMENT = 512,
  ISSUE_RESOLVED = 1024,
  ISSUE_REOPENED = 2048,
  MEDIA_AUTO_REQUESTED = 4096,
  NEW_SEASON = 16384,
  RELEASE_DATE_CHANGED = 32768,
}

export const ALL_NOTIFICATIONS = Object.values(Notification)
  .filter((value) => !isNaN(Number(value)))
  .reduce((total, value) => total + Number(value), 0);

/** Returns whether a notification mask contains one or more requested types. */
export const hasNotificationType = (
  types: Notification | Notification[],
  value: number
): boolean => {
  if (types === 0) return true;

  const total = Array.isArray(types)
    ? types.reduce((sum, type) => sum + type, 0)
    : types;

  // Test notifications are synthetic and should not affect filtering.
  if (!(value & Notification.TEST_NOTIFICATION)) {
    value += Notification.TEST_NOTIFICATION;
  }

  return !!(value & total);
};
