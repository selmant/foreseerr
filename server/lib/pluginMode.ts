import { createHmac, timingSafeEqual } from 'crypto';

export const PLUGIN_PUBLIC_BASE_PATH = '/Foreseerr';

export function isPluginMode(): boolean {
  const flag = process.env.FORESEERR_PLUGIN;
  return flag === '1' || flag?.toLowerCase() === 'true';
}

export function pluginPublicBasePath(): string {
  if (!isPluginMode()) {
    return '';
  }
  const raw = process.env.FORESEERR_BASE_PATH?.trim();
  if (!raw || raw === '/') {
    return PLUGIN_PUBLIC_BASE_PATH;
  }
  return raw.startsWith('/')
    ? raw.replace(/\/$/, '')
    : `/${raw.replace(/\/$/, '')}`;
}

export function pluginCookiePath(): string {
  return pluginPublicBasePath() || '/';
}

export function pluginSharedSecret(): string {
  return process.env.FORESEERR_PLUGIN_SECRET?.trim() ?? '';
}

export function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) {
    return false;
  }
  const value = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return value === '127.0.0.1' || value === '::1' || value === 'localhost';
}

export function pluginMintMessage(
  jellyfinUserId: string,
  timestamp: number
): string {
  return `${jellyfinUserId}\n${timestamp}`;
}

export function signPluginMint(
  secret: string,
  jellyfinUserId: string,
  timestamp: number
): string {
  return createHmac('sha256', secret)
    .update(pluginMintMessage(jellyfinUserId, timestamp))
    .digest('hex');
}

export function verifyPluginMintSignature(options: {
  secret: string;
  jellyfinUserId: string;
  timestamp: number;
  signature: string;
  nowSeconds?: number;
  maxSkewSeconds?: number;
}): boolean {
  const {
    secret,
    jellyfinUserId,
    timestamp,
    signature,
    nowSeconds = Math.floor(Date.now() / 1000),
    maxSkewSeconds = 120,
  } = options;
  if (!secret || !jellyfinUserId || !signature || !Number.isFinite(timestamp)) {
    return false;
  }
  if (Math.abs(nowSeconds - timestamp) > maxSkewSeconds) {
    return false;
  }
  const expected = signPluginMint(secret, jellyfinUserId, timestamp);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length || a.length === 0) {
    return false;
  }
  return timingSafeEqual(a, b);
}
