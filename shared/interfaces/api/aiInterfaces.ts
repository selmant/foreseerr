/** Which provider a connection talks to. */
export type AiConnectionKind = 'chatgpt' | 'openai';

/** `reauth`, `plan_disabled` and `signed_out` need the owner to sign in again. */
export type AiConnectionStatus =
  | 'ok'
  | 'reauth'
  | 'plan_disabled'
  | 'signed_out';

export type AiPreset = 'fast' | 'balanced' | 'best';

/** A connection as its owner sees it. Credentials are never returned. */
export interface AiConnection {
  kind: AiConnectionKind;
  status: AiConnectionStatus;
  model: string | null;
  lastError: string | null;
  updatedAt: string | null;
  lastUsedAt: string | null;
  /** Endpoint connections. */
  providerLabel?: string;
  baseUrl?: string | null;
  hasApiKey?: boolean;
  /** ChatGPT connections. */
  accountEmail?: string | null;
  accountName?: string | null;
  manageUsageUrl?: string;
}

export interface AiModel {
  id: string;
  label: string;
}

export type AiPresets = Record<AiPreset, string | null>;

export interface AiSettings {
  enabled: boolean;
  shareServerConnection: boolean;
  allowUserChatgpt: boolean;
  allowUserEndpoints: boolean;
  allowUserModelChoice: boolean;
  models: { fast: string | null; best: string | null };
  presets: AiPresets;
  searxng: { enabled: boolean; url: string };
  connection: AiConnection | null;
  secretKey: { source: 'env' | 'file' | 'config'; besideDatabase: boolean };
}

export type AiUnavailableReason =
  | 'disabled'
  | 'own_missing'
  | 'own_needs_sign_in'
  | 'no_server_connection';

export type AiEffective =
  | {
      available: true;
      source: 'own' | 'server';
      kind: AiConnectionKind;
      model: string | null;
      preset: AiPreset | null;
      accountEmail: string | null;
      usesChatgptPlan: boolean;
      manageUsageUrl: string | null;
    }
  | { available: false; reason: AiUnavailableReason };

export interface AiMe {
  enabled: boolean;
  policy: {
    allowChatgpt: boolean;
    allowEndpoints: boolean;
    allowModelChoice: boolean;
  };
  server: {
    kind: AiConnectionKind;
    status: AiConnectionStatus;
    providerLabel: string;
    presets: AiPresets;
  } | null;
  own: AiConnection | null;
  preferences: {
    useOwnConnection: boolean;
    model: AiPreset | null;
    useHistory: boolean;
    historyConsentAt: string | null;
  };
  effective: AiEffective;
  chatgptRedirectUri: string;
  /** Set by `DELETE /ai/me/connection` for a ChatGPT sign-out. */
  revoked?: boolean | null;
  /** Set by `POST /ai/me/chatgpt/complete`. */
  planEnabled?: boolean;
}

export type AiErrorCode =
  | 'input'
  | 'not_configured'
  | 'reauth'
  | 'usage_limit'
  | 'not_eligible'
  | 'unavailable'
  | 'upstream'
  | 'internal';

export interface AiErrorBody {
  message: string;
  code: AiErrorCode;
  manageUsageUrl?: string;
}

export interface AiTestResult {
  ok: boolean;
  models: number;
  model?: string;
  reply?: string;
}
