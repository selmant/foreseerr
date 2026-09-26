import { isPluginMode } from '@server/lib/pluginMode';
import { getSettings } from '@server/lib/settings';

interface HostnameParams {
  useSsl?: boolean;
  ip?: string;
  port?: number;
  urlBase?: string;
}

export const getHostname = (params?: HostnameParams): string => {
  const settings = params ? params : getSettings().jellyfin;

  const { useSsl, ip, port, urlBase } = settings;

  const hostname = `${useSsl ? 'https' : 'http'}://${ip}:${port}${urlBase}`;

  return hostname;
};

/**
 * Base for links that browsers follow into Jellyfin Web. The plugin serves
 * Foreseerr from Jellyfin's own origin, so without a public URL a same-origin
 * path works where the loopback address would not.
 */
export const getJellyfinLinkHost = (): string => {
  const { externalHostname, urlBase } = getSettings().jellyfin;
  if (externalHostname) return externalHostname;
  return isPluginMode() ? (urlBase ?? '') : getHostname();
};
