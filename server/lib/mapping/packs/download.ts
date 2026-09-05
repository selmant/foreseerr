import logger from '@server/logger';
import { configDirectory } from '@server/utils/runtimePaths';
import axios from 'axios';
import { createHash, randomBytes } from 'crypto';
import { createWriteStream, promises as fsp } from 'fs';
import path from 'path';
import type { Readable } from 'stream';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';

export const getPackDirectory = (): string =>
  path.join(configDirectory(), 'mapping-packs');

export const PACK_DIRECTORY = getPackDirectory();

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
  path.join(getPackDirectory(), filenameFor(key, format));

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
  validate: (body: string) => void | Promise<void>;
  timeoutMsec?: number;
  onProgress?: (event: {
    received: number;
    total?: number;
    mirror: string;
  }) => void;
}

/**
 * Fetch a pack through its mirror list, validating before publishing.
 *
 * Conditional GET first: both `raw.githubusercontent.com` and GitHub release
 * assets expose `etag`/`last-modified`, and the old loader re-downloaded 7.5 MB
 * every 24 h regardless.
 */
const contentLength = (
  headers: Record<string, unknown>
): number | undefined => {
  const encoding = headers['content-encoding'];
  if (typeof encoding === 'string' && encoding && encoding !== 'identity') {
    // Length is the compressed size; byte counts after Axios decompresses.
    return undefined;
  }
  const raw = headers['content-length'];
  const value =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? Number(raw)
        : undefined;
  return value && Number.isFinite(value) && value > 0 ? value : undefined;
};

const unlinkQuiet = async (file: string): Promise<void> => {
  try {
    await fsp.unlink(file);
  } catch {
    // Missing is the success case after a failed mirror.
  }
};

export async function fetchPack({
  key,
  format,
  mirrors,
  cache,
  validate,
  timeoutMsec = 60_000,
  onProgress,
}: FetchPackOptions): Promise<PackFetchResult> {
  await fsp.mkdir(getPackDirectory(), { recursive: true });
  const target = packPath(key, format);
  const lastGood = lastGoodPath(key, format);
  const attempts: { mirror: string; error: string }[] = [];

  for (const mirror of mirrors) {
    const temporary = `${target}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      const response = await axios.get<Readable>(mirror, {
        timeout: timeoutMsec,
        responseType: 'stream',
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
        response.data.destroy();
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

      const total = contentLength(
        response.headers as unknown as Record<string, unknown>
      );
      let received = 0;
      const counter = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          onProgress?.({ received, total, mirror });
          callback(null, chunk);
        },
      });
      await pipeline(response.data, counter, createWriteStream(temporary));

      const body = await fsp.readFile(temporary, 'utf8');
      if (!body.length) {
        throw new Error('empty response body');
      }
      await validate(body);

      // Validate, then rename: the live path is only ever replaced by a file
      // already known to parse.
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
      await unlinkQuiet(temporary);
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
      await validate(body);
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
