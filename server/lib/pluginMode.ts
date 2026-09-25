import { createHmac, timingSafeEqual } from 'crypto';
import type { RequestHandler } from 'express';

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
  if (
    !secret ||
    !jellyfinUserId ||
    !/^[a-f0-9]{64}$/i.test(signature) ||
    !Number.isSafeInteger(timestamp)
  ) {
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

/** All sidecar traffic comes from the plugin, including health checks. */
export const requirePluginProxy: RequestHandler = (req, res, next) => {
  if (!isPluginMode()) return next();
  if (
    !isLoopbackAddress(req.socket.remoteAddress) ||
    !verifyPluginSecret(req.get('x-foreseerr-plugin-secret'))
  ) {
    res.status(403).json({ error: 'Plugin proxy authentication required.' });
    return;
  }
  next();
};

export function verifyPluginSecret(provided: string | undefined): boolean {
  const expected = pluginSharedSecret();
  if (!provided || !expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * express-openapi-validator matches routes against req.originalUrl, which
 * keeps the plugin mount prefix. Without matching servers every API request
 * silently skips validation, including the Express 5 req.query shim that
 * routes rely on to rewrite query defaults.
 */
export function pluginApiSpec<T extends object>(
  spec: T
): T & { servers: { url: string }[] } {
  return {
    ...structuredClone(spec),
    servers: [{ url: `${pluginPublicBasePath()}/api/v1` }],
  };
}

/** Only configured local paths can enter the HTML base element. */
export function pluginIndexHtml(html: string): string {
  const base = (
    process.env.FORESEERR_PUBLIC_BASE_PATH || pluginPublicBasePath()
  ).replace(/\/$/, '');
  // Jellyfin allows dots in BaseUrl (e.g. /media.server); none of these
  // characters can terminate the attribute they are written into.
  if (!/^\/(?!\/)[a-zA-Z0-9/._~-]+$/.test(base)) {
    throw new Error('Invalid plugin public base path');
  }
  return html
    .replace(
      '<head>',
      `<head><base href="${base}/"><meta name="foreseerr-base-path" content="${base}">`
    )
    .replace(/<link\s+rel="manifest"[^>]*>/g, '');
}
