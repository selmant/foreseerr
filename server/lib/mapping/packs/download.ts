import logger from '@server/logger';
import axios from 'axios';
import { createHash } from 'crypto';
import { promises as fsp } from 'fs';
import path from 'path';

export const PACK_DIRECTORY = process.env.CONFIG_DIRECTORY
  ? path.join(process.env.CONFIG_DIRECTORY, 'mapping-packs')
  : path.join(__dirname, '../../../../config/mapping-packs');

export interface PackCacheState {
  etag?: string;
  lastModified?: string;
}

export interface PackFetchResult {
  /** `notModified` means the local copy is still current. */
  status: 'downloaded' | 'notModified' | 'lastGood';
  path: string;
  body?: string;
  etag?: string;
  lastModified?: string;
  mirror?: string;
  bytes?: number;
  sha256?: string;
}

export class PackFetchError extends Error {
  public constructor(
    message: string,
    public readonly attempts: { mirror: string; error: string }[]
  ) {
    super(message);
  }
}

const filenameFor = (key: string, format: string): string => {
  const extension =
    format === 'xml-animelist'
      ? 'xml'
      : format === 'yaml-map'
        ? 'yaml'
        : format === 'ndjson'
          ? 'ndjson'
          : 'json';
  return `${key}.${extension}`;
};

export const packPath = (key: string, format: string): string =>
  path.join(PACK_DIRECTORY, filenameFor(key, format));

/** Retained beside the live copy so a bad refresh can never leave nothing. */
export const lastGoodPath = (key: string, format: string): string =>
  `${packPath(key, format)}.last-good`;

const readIfPresent = async (file: string): Promise<string | undefined> => {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
};

export interface FetchPackOptions {
  key: string;
  format: string;
  mirrors: string[];
  cache?: PackCacheState;
  /**
   * Must throw when the payload is unusable. Validation runs on the temp file
   * before the rename, because the previous downloader piped the response
   * straight onto the live path: a truncated transfer corrupted the only copy
   * and refreshed its mtime, so the staleness check then skipped re-downloading
   * and every load threw for the next 24 hours.
   */
  validate: (body: string) => void;
  timeoutMsec?: number;
}

/**
 * Fetch a pack through its mirror list, validating before publishing.
 *
 * Conditional GET first: both `raw.githubusercontent.com` and GitHub release
 * assets expose `etag`/`last-modified`, and the old loader re-downloaded 7.5 MB
 * every 24 h regardless.
 */
export async function fetchPack({
  key,
  format,
  mirrors,
  cache,
  validate,
  timeoutMsec = 60_000,
}: FetchPackOptions): Promise<PackFetchResult> {
  await fsp.mkdir(PACK_DIRECTORY, { recursive: true });
  const target = packPath(key, format);
  const lastGood = lastGoodPath(key, format);
  const attempts: { mirror: string; error: string }[] = [];

  for (const mirror of mirrors) {
    try {
      const response = await axios.get<string>(mirror, {
        timeout: timeoutMsec,
        responseType: 'text',
        transformResponse: [(data) => data],
        // statically.io answers 301, and release assets redirect to blob storage.
        maxRedirects: 5,
        headers: {
          ...(cache?.etag ? { 'If-None-Match': cache.etag } : {}),
          ...(cache?.lastModified
            ? { 'If-Modified-Since': cache.lastModified }
            : {}),
        },
        // 304 is a success here, not an error.
        validateStatus: (status) => status === 304 || status < 400,
      });
      const { status } = response;
      if (status === 304) {
        const existing = await readIfPresent(target);
        if (existing) {
          return {
            status: 'notModified',
            path: target,
            body: existing,
            etag: cache?.etag,
            lastModified: cache?.lastModified,
            mirror,
          };
        }
        throw new Error('mirror answered 304 but no local copy exists');
      }
      const body = response.data;
      if (typeof body !== 'string' || !body.length) {
        throw new Error('empty response body');
      }
      validate(body);

      // Write, validate, then rename: the live path is only ever replaced by a
      // file already known to parse.
      const temporary = `${target}.${process.pid}.tmp`;
      await fsp.writeFile(temporary, body, 'utf8');
      const previous = await readIfPresent(target);
      if (previous) {
        await fsp.writeFile(lastGood, previous, 'utf8');
      }
      await fsp.rename(temporary, target);

      return {
        status: 'downloaded',
        path: target,
        body,
        etag:
          typeof response.headers?.etag === 'string'
            ? response.headers.etag
            : undefined,
        lastModified:
          typeof response.headers?.['last-modified'] === 'string'
            ? response.headers['last-modified']
            : undefined,
        mirror,
        bytes: Buffer.byteLength(body),
        sha256: createHash('sha256').update(body).digest('hex'),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({ mirror, error: message });
      logger.debug('Mapping pack mirror failed', {
        label: 'Mapping',
        pack: key,
        mirror,
        errorMessage: message,
      });
    }
  }

  // Every mirror failed. Serve whatever last parsed rather than going dark.
  for (const candidate of [target, lastGood]) {
    const body = await readIfPresent(candidate);
    if (!body) continue;
    try {
      validate(body);
      logger.warn('Serving the last known-good mapping pack', {
        label: 'Mapping',
        pack: key,
        file: candidate,
      });
      return { status: 'lastGood', path: candidate, body };
    } catch {
      // Fall through to the next candidate.
    }
  }

  throw new PackFetchError(
    `Unable to fetch mapping pack "${key}" from any mirror`,
    attempts
  );
}

/**
 * Read a pack that is already on disk — no network.
 *
 * Used on boot when packs were shipped inside the package (or left from a
 * previous refresh) so the container does not wait on GitHub/jsDelivr before
 * it can resolve AniList ids.
 */
export async function readLocalPack(
  key: string,
  format: string
): Promise<{ body: string; path: string } | undefined> {
  await fsp.mkdir(PACK_DIRECTORY, { recursive: true });
  for (const candidate of [packPath(key, format), lastGoodPath(key, format)]) {
    const body = await readIfPresent(candidate);
    if (body?.length) return { body, path: candidate };
  }
  return undefined;
}

/**
 * Copy bundled pack files from the install into the writable config directory.
 *
 * The Nix package ships the daily mapping dumps under
 * `$out/share/mapping-packs`; config is a bind-mounted volume. Only missing
 * (or empty) targets are filled so an operator's refreshed copy is never
 * overwritten by a stale bundle.
 */
export async function syncBundledPacks(
  bundledDirectory = process.env.FORESEER_BUNDLED_PACKS
): Promise<string[]> {
  if (!bundledDirectory) return [];
  let entries: string[];
  try {
    entries = await fsp.readdir(bundledDirectory);
  } catch {
    return [];
  }

  await fsp.mkdir(PACK_DIRECTORY, { recursive: true });
  const copied: string[] = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const source = path.join(bundledDirectory, name);
    const target = path.join(PACK_DIRECTORY, name);
    try {
      const sourceStat = await fsp.stat(source);
      if (!sourceStat.isFile()) continue;
      const existing = await readIfPresent(target);
      if (existing && existing.length > 0) continue;
      await fsp.copyFile(source, target);
      copied.push(name);
    } catch (error) {
      logger.warn('Unable to copy bundled mapping pack', {
        label: 'Mapping',
        pack: name,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return copied;
}
