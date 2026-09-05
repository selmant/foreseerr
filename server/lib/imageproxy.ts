import logger from '@server/logger';
import { proxyRequestInterceptor } from '@server/utils/customProxyAgent';
import { configDirectory } from '@server/utils/runtimePaths';
import axios, { type AxiosInstance } from 'axios';
import rateLimit, { type rateLimitOptions } from 'axios-rate-limit';
import { createHash } from 'crypto';
import { promises } from 'fs';
import mime from 'mime';
import path, { join } from 'path';

type ImageResponse = {
  meta: {
    revalidateAfter: number;
    curRevalidate: number;
    isStale: boolean;
    etag: string;
    extension: string | null;
    cacheKey: string;
    cacheMiss: boolean;
  };
  imageBuffer: Buffer;
};

const baseCacheDirectory = process.env.CACHE_DIRECTORY
  ? `${process.env.CACHE_DIRECTORY}/images`
  : path.join(configDirectory(), 'cache/images');
const DEFAULT_TRANSIENT_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const configuredTransientCacheBytes = Number(
  process.env.FORESEER_CACHE_LIMIT_BYTES ?? DEFAULT_TRANSIENT_CACHE_BYTES
);
const transientCacheBytes = Number.isFinite(configuredTransientCacheBytes)
  ? Math.max(configuredTransientCacheBytes, 128 * 1024 * 1024)
  : DEFAULT_TRANSIENT_CACHE_BYTES;
// The combined desktop budget reserves 62.5% for images and 37.5% for CEF.
// Cleanup returns images to 50% of the combined budget to avoid thrashing.
const IMAGE_CACHE_HIGH_WATER_BYTES = Math.floor(transientCacheBytes * 0.625);
const IMAGE_CACHE_TRIM_TARGET_BYTES = Math.floor(transientCacheBytes * 0.5);
let cleanupInProgress = false;

/** Coerce Axios 1.18+ header values (string | number | boolean | string[]) to string. */
const headerToString = (value: unknown, fallback = ''): string => {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : fallback;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return fallback;
};

class ImageProxy {
  public static async clearAll(): Promise<void> {
    await promises.rm(baseCacheDirectory, { recursive: true, force: true });
  }

  public static async getCombinedStats(): Promise<{
    usedBytes: number;
    entries: number;
    highWaterBytes: number;
    trimTargetBytes: number;
  }> {
    const entries = await ImageProxy.listEntries();
    return {
      usedBytes: entries.reduce((total, entry) => total + entry.size, 0),
      entries: entries.length,
      highWaterBytes: IMAGE_CACHE_HIGH_WATER_BYTES,
      trimTargetBytes: IMAGE_CACHE_TRIM_TARGET_BYTES,
    };
  }

  public static async maintainCache(): Promise<void> {
    if (cleanupInProgress) return;
    cleanupInProgress = true;
    try {
      const entries = await ImageProxy.listEntries(true);
      let usedBytes = entries.reduce((total, entry) => total + entry.size, 0);
      if (usedBytes > IMAGE_CACHE_HIGH_WATER_BYTES) {
        for (const entry of entries.sort(
          (a, b) => a.accessedAt - b.accessedAt
        )) {
          if (usedBytes <= IMAGE_CACHE_TRIM_TARGET_BYTES) break;
          await promises.rm(entry.directory, { recursive: true, force: true });
          usedBytes -= entry.size;
        }
      }
    } catch (error) {
      logger.warn('Image cache maintenance failed', {
        label: 'Image Cache',
        message: (error as Error).message,
      });
    } finally {
      cleanupInProgress = false;
    }
  }

  private static async listEntries(
    removeInvalid = false
  ): Promise<{ directory: string; size: number; accessedAt: number }[]> {
    const result: {
      directory: string;
      size: number;
      accessedAt: number;
    }[] = [];
    let groups: string[];
    try {
      groups = await promises.readdir(baseCacheDirectory);
    } catch {
      return result;
    }
    for (const group of groups) {
      let keys: string[];
      try {
        keys = await promises.readdir(join(baseCacheDirectory, group));
      } catch {
        continue;
      }
      for (const key of keys) {
        const directory = join(baseCacheDirectory, group, key);
        let files: string[];
        try {
          files = await promises.readdir(directory);
        } catch {
          continue;
        }
        const file = files[0];
        const expiresAt = Number(file?.split('.')[1]);
        if (!file || !Number.isFinite(expiresAt) || Date.now() > expiresAt) {
          if (removeInvalid)
            await promises.rm(directory, { recursive: true, force: true });
          continue;
        }
        try {
          const stat = await promises.stat(join(directory, file));
          result.push({
            directory,
            size: stat.size,
            accessedAt: stat.atimeMs || stat.mtimeMs,
          });
        } catch {
          if (removeInvalid)
            await promises.rm(directory, { recursive: true, force: true });
        }
      }
    }
    return result;
  }
  public static async clearCache(key: string) {
    let deletedImages = 0;
    const cacheDirectory = path.join(baseCacheDirectory, key);

    try {
      const files = await promises.readdir(cacheDirectory);

      for (const file of files) {
        const filePath = path.join(cacheDirectory, file);
        const stat = await promises.lstat(filePath);

        if (stat.isDirectory()) {
          const imageFiles = await promises.readdir(filePath);

          for (const imageFile of imageFiles) {
            const [, expireAtSt] = imageFile.split('.');
            const expireAt = Number(expireAtSt);
            const now = Date.now();

            if (now > expireAt) {
              await promises.rm(path.join(filePath), {
                recursive: true,
              });
              deletedImages += 1;
            }
          }
        }
      }
    } catch (e) {
      if (e.code === 'ENOENT') {
        return;
      }
      logger.error('Failed to read directory', {
        label: 'Image Cache',
        message: e.message,
      });
    }

    logger.info(`Cleared ${deletedImages} stale image(s) from cache '${key}'`, {
      label: 'Image Cache',
    });
  }

  public static async getImageStats(
    key: string
  ): Promise<{ size: number; imageCount: number }> {
    const cacheDirectory = path.join(baseCacheDirectory, key);

    const imageTotalSize = await ImageProxy.getDirectorySize(cacheDirectory);
    const imageCount = await ImageProxy.getImageCount(cacheDirectory);

    return {
      size: imageTotalSize,
      imageCount,
    };
  }

  private static async getDirectorySize(dir: string): Promise<number> {
    try {
      const files = await promises.readdir(dir, {
        withFileTypes: true,
      });

      const paths = files.map(async (file) => {
        const path = join(dir, file.name);

        if (file.isDirectory()) return await ImageProxy.getDirectorySize(path);

        if (file.isFile()) {
          const { size } = await promises.stat(path);

          return size;
        }

        return 0;
      });

      return (await Promise.all(paths))
        .flat(Infinity)
        .reduce((i, size) => i + size, 0);
    } catch (e) {
      if (e.code === 'ENOENT') {
        return 0;
      }
    }

    return 0;
  }

  private static async getImageCount(dir: string) {
    try {
      const files = await promises.readdir(dir);

      return files.length;
    } catch (e) {
      if (e.code === 'ENOENT') {
        return 0;
      }
    }

    return 0;
  }

  private axios: AxiosInstance;
  private cacheVersion;
  private key;

  constructor(
    key: string,
    baseUrl: string,
    options: {
      cacheVersion?: number;
      rateLimitOptions?: rateLimitOptions;
      headers?: Record<string, string>;
    } = {}
  ) {
    this.cacheVersion = options.cacheVersion ?? 1;
    this.key = key;
    this.axios = axios.create({
      baseURL: baseUrl,
      headers: options.headers,
    });
    this.axios.interceptors.request.use(proxyRequestInterceptor);

    if (options.rateLimitOptions) {
      this.axios = rateLimit(this.axios, options.rateLimitOptions);
    }
  }

  public async getImage(
    path: string,
    fallbackPath?: string
  ): Promise<ImageResponse> {
    const cacheKey = this.getCacheKey(path);

    const imageResponse = await this.get(cacheKey);

    if (!imageResponse) {
      const newImage = await this.set(path, cacheKey);

      if (!newImage) {
        if (fallbackPath) {
          return await this.getImage(fallbackPath);
        } else {
          throw new Error('Failed to load image');
        }
      }

      return newImage;
    }

    // If the image is stale, we will revalidate it in the background.
    if (imageResponse.meta.isStale) {
      this.set(path, cacheKey);
    }

    return imageResponse;
  }

  public async clearCachedImage(path: string) {
    // find cacheKey
    const cacheKey = this.getCacheKey(path);
    const directory = join(this.getCacheDirectory(), cacheKey);

    try {
      await promises.access(directory);
    } catch (e) {
      if (e.code === 'ENOENT') {
        logger.debug(
          `Cache directory '${cacheKey}' does not exist; nothing to clear.`,
          {
            label: 'Image Cache',
          }
        );
        return;
      } else {
        logger.error('Error checking cache directory existence', {
          label: 'Image Cache',
          message: e.message,
        });
        return;
      }
    }

    try {
      const files = await promises.readdir(directory);

      await promises.rm(directory, { recursive: true });

      logger.debug(`Cleared ${files[0]} from cache 'avatar'`, {
        label: 'Image Cache',
      });
    } catch (e) {
      logger.error('Failed to clear cached image', {
        label: 'Image Cache',
        message: e.message,
      });
    }
  }

  private async get(cacheKey: string): Promise<ImageResponse | null> {
    try {
      const directory = join(this.getCacheDirectory(), cacheKey);
      const files = await promises.readdir(directory);
      const now = Date.now();

      for (const file of files) {
        const [maxAgeSt, expireAtSt, etag, extension] = file.split('.');
        const cacheFile = join(directory, file);
        const buffer = await promises.readFile(cacheFile);
        const stat = await promises.stat(cacheFile);
        if (Date.now() - stat.atimeMs > 60 * 60 * 1000) {
          await promises
            .utimes(cacheFile, new Date(), stat.mtime)
            .catch(() => undefined);
        }
        const expireAt = Number(expireAtSt);
        const maxAge = Number(maxAgeSt);

        return {
          meta: {
            curRevalidate: maxAge,
            revalidateAfter: maxAge * 1000 + now,
            isStale: now > expireAt,
            etag,
            extension,
            cacheKey,
            cacheMiss: false,
          },
          imageBuffer: buffer,
        };
      }
    } catch {
      // No files. Treat as empty cache.
    }

    return null;
  }

  private async set(
    path: string,
    cacheKey: string
  ): Promise<ImageResponse | null> {
    try {
      const directory = join(this.getCacheDirectory(), cacheKey);
      const response = await this.axios.get(path, {
        responseType: 'arraybuffer',
      });

      const buffer = Buffer.from(response.data, 'binary');

      const contentType = headerToString(response.headers['content-type']);
      const extension = (mime.getExtension(contentType) || '').replace(
        /[^\w-]/g,
        ''
      );

      let maxAge = Number(
        headerToString(response.headers['cache-control'], '0').split('=')[1]
      );

      if (!maxAge) maxAge = 86400;
      const expireAt = Date.now() + maxAge * 1000;
      const etag = headerToString(response.headers.etag).replace(/[^\w-]/g, '');

      await this.writeToCacheDir(
        directory,
        extension,
        maxAge,
        expireAt,
        buffer,
        etag
      );
      void ImageProxy.maintainCache();

      return {
        meta: {
          curRevalidate: maxAge,
          revalidateAfter: expireAt,
          isStale: false,
          etag,
          extension,
          cacheKey,
          cacheMiss: true,
        },
        imageBuffer: buffer,
      };
    } catch (e) {
      logger.debug('Something went wrong caching image.', {
        label: 'Image Cache',
        errorMessage: e.message,
      });
      return null;
    }
  }

  private async writeToCacheDir(
    dir: string,
    extension: string | null,
    maxAge: number,
    expireAt: number,
    buffer: Buffer,
    etag: string
  ) {
    const filename = join(dir, `${maxAge}.${expireAt}.${etag}.${extension}`);

    await promises.rm(dir, { force: true, recursive: true }).catch(() => {
      // do nothing
    });

    await promises.mkdir(dir, { recursive: true });
    await promises.writeFile(filename, buffer);
  }

  private getCacheKey(path: string) {
    return this.getHash([this.key, this.cacheVersion, path]);
  }

  private getHash(items: (string | number | Buffer)[]) {
    const hash = createHash('sha256');
    for (const item of items) {
      if (typeof item === 'number') hash.update(String(item));
      else {
        hash.update(item);
      }
    }
    // See https://en.wikipedia.org/wiki/Base64#Filenames
    return hash.digest('base64').replace(/\//g, '-');
  }

  private getCacheDirectory() {
    return path.join(baseCacheDirectory, this.key);
  }
}

export default ImageProxy;
