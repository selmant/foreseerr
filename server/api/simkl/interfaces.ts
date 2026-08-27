export interface SimklPinCodeResponse {
  user_code?: string;
  device_code?: string;
  code?: string;
  url?: string;
  expires_in?: number;
  expires?: number;
  interval?: number;
}

export interface SimklPinTokenResponse {
  access_token?: string;
  token?: string;
  error?: string;
}

export type SimklActivities = Record<string, unknown> & { all?: string };
export type SimklSyncResponse = Record<string, unknown>;

export interface SimklUserSettingsResponse {
  user?: { id?: number | string; name?: string; username?: string };
  account?: { id?: number | string; name?: string; username?: string };
}
