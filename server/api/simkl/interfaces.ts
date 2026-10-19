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

/** AUTH V2 device authorization (RFC 8628). `device_code` is a secret. */
export interface SimklDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
}

/** AUTH V2 token response, identical for the device and refresh grants. */
export interface SimklOAuthTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export type SimklActivities = Record<string, unknown> & {
  all?: string | number | null;
};
export type SimklSyncResponse = Record<string, unknown>;

export interface SimklUserSettingsResponse {
  user?: { id?: number | string; name?: string; username?: string };
  account?: { id?: number | string };
}
