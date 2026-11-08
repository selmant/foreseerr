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
  dailyLimit: number;
  /** Server connection tokens per month; 0 means no budget. */
  monthlyTokenBudget: number;
  rowRefreshDays: number;
  /** The nightly job prepares rows and weekly picks for active people. */
  autoPicks: boolean;
  /** Finished requests are deleted after this many days; 0 keeps them. */
  historyDays: number;
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
  usage: AiUsage;
  preferences: {
    useOwnConnection: boolean;
    model: AiPreset | null;
    useHistory: boolean;
    historyConsentAt: string | null;
    weeklyPicks: boolean;
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
  | 'internal'
  | 'daily_limit';

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

export type AiRunStage =
  | 'planning'
  | 'searching'
  | 'ranking'
  | 'done'
  | 'failed';

export type AiVerdict = 'like' | 'dislike' | 'seen' | 'not_interested';

export interface AiRecommendRequest {
  prompt?: string;
  seed?: { mediaType: 'movie' | 'tv'; tmdbId: number } | null;
  only?: 'movie' | 'tv' | null;
  anime?: boolean;
  /** `library`: only titles in the library; `new`: only ones not in it yet. */
  availability?: AiAvailability | null;
  refinements?: string[];
}

export type AiAvailability = 'library' | 'new';

export type AiOrigin = 'manual' | 'row' | 'scheduled' | 'weekly';

export interface AiPick {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  why: string;
  source: string;
  feedback: AiVerdict | null;
  // The same shape Discover rows use (MovieResult / TvResult with mediaInfo).
  item: Record<string, unknown>;
}

export interface AiRunResult {
  headline: string;
  summary: string;
  picks: AiPick[];
  refinements: string[];
  candidates: number;
  usedWeb: boolean;
}

export interface AiRun {
  id: number;
  stage: AiRunStage;
  createdAt: string;
  request: {
    prompt: string;
    seed: { mediaType: 'movie' | 'tv'; tmdbId: number; title: string } | null;
    only: 'movie' | 'tv' | null;
    anime: boolean;
    availability?: AiAvailability | null;
    refinements: string[];
  };
  source: 'own' | 'server';
  model: string | null;
  origin?: AiOrigin;
  result: AiRunResult | null;
  error: AiErrorBody | null;
}

export interface AiRunSummary {
  id: number;
  stage: AiRunStage;
  createdAt: string;
  prompt: string;
  seedTitle: string | null;
  only: 'movie' | 'tv' | null;
  anime: boolean | null;
  availability: AiAvailability | null;
  refinements: string[] | null;
  headline: string | null;
  pickCount: number;
  /** TMDB poster paths of the first few picks. */
  posters: string[];
  /** Picks of this request the person requested, and liked. */
  requested: number;
  liked: number;
  model: string | null;
}

/** How picks went over the last 30 days. */
export interface AiOutcomes {
  picks: number;
  requested: number;
  watched: number;
  liked: number;
}

export interface AiUsageReport {
  days: number;
  month: { serverTokens: number; budget: number };
  people: {
    userId: number;
    name: string;
    avatar: string | null;
    runs: number;
    manual: number;
    automatic: number;
    failed: number;
    today: number;
    tokens: number;
    serverTokens: number;
    lastRunAt: string | null;
    outcomes: AiOutcomes;
  }[];
  models: {
    model: string | null;
    runs: number;
    failed: number;
    inputTokens: number;
    outputTokens: number;
    picks: number;
    requested: number;
    watched: number;
    ratedWell: number;
  }[];
  failures: {
    id: number;
    name: string;
    createdAt: string;
    model: string | null;
    origin: AiOrigin;
    message: string | null;
  }[];
}

export interface AiFeedbackItem {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  kind: AiVerdict;
  title: string;
  updatedAt: string;
}

export interface AiTaste {
  card: string;
  updatedAt: string | null;
  feedbackCount: number;
  pendingFeedback: number;
  outcomes?: AiOutcomes;
}

export interface AiUsage {
  dailyLimit: number | null;
  usedToday: number;
}
