import type { AnilistMediaFormat } from '@server/api/anilist/interfaces';
import logger from '@server/logger';
import axios from 'axios';
import fs, { promises as fsp } from 'fs';
import path from 'path';

const UPDATE_INTERVAL_MSEC = 24 * 3600 * 1000;
const MAPPING_URL =
  'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json';
const LOCAL_PATH = process.env.CONFIG_DIRECTORY
  ? `${process.env.CONFIG_DIRECTORY}/anilist-tmdb.json`
  : path.join(__dirname, '../../../config/anilist-tmdb.json');

export interface AnilistTmdbMapping {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
}

interface FribbTmdbIds {
  tv?: number;
  movie?: number | number[];
}

interface FribbEntry {
  type?: string;
  anilist_id?: number;
  themoviedb_id?: FribbTmdbIds;
}

function firstMovieId(ids?: FribbTmdbIds): number | undefined {
  const movie = ids?.movie;
  if (Array.isArray(movie)) {
    const id = Number(movie[0]);
    return Number.isFinite(id) && id > 0 ? id : undefined;
  }
  if (movie != null) {
    const id = Number(movie);
    return Number.isFinite(id) && id > 0 ? id : undefined;
  }
  return undefined;
}

function tvId(ids?: FribbTmdbIds): number | undefined {
  if (ids?.tv == null) {
    return undefined;
  }
  const id = Number(ids.tv);
  return Number.isFinite(id) && id > 0 ? id : undefined;
}

export function anilistFormatToMediaType(
  format?: AnilistMediaFormat | null
): 'movie' | 'tv' {
  return format === 'MOVIE' ? 'movie' : 'tv';
}

export function resolveFribbTmdb(
  ids: FribbTmdbIds | undefined,
  format?: AnilistMediaFormat | null
): AnilistTmdbMapping | null {
  const movie = firstMovieId(ids);
  const tv = tvId(ids);
  const preferMovie = anilistFormatToMediaType(format) === 'movie';

  if (preferMovie && movie) {
    return { tmdbId: movie, mediaType: 'movie' };
  }
  if (!preferMovie && tv) {
    return { tmdbId: tv, mediaType: 'tv' };
  }
  if (tv) {
    return { tmdbId: tv, mediaType: 'tv' };
  }
  if (movie) {
    return { tmdbId: movie, mediaType: 'movie' };
  }
  return null;
}

export function indexFribbEntries(entries: FribbEntry[]): {
  byAnilist: Map<number, AnilistTmdbMapping>;
  byTmdb: Map<string, number>;
} {
  const byAnilist = new Map<number, AnilistTmdbMapping>();
  const byTmdb = new Map<string, number>();

  for (const entry of entries) {
    const anilistId = Number(entry.anilist_id);
    if (!Number.isFinite(anilistId) || anilistId <= 0) {
      continue;
    }
    const mapped = resolveFribbTmdb(
      entry.themoviedb_id,
      entry.type === 'MOVIE' ? 'MOVIE' : entry.type
    );
    if (!mapped) {
      continue;
    }
    if (!byAnilist.has(anilistId)) {
      byAnilist.set(anilistId, mapped);
    }
    const reverseKey = `${mapped.mediaType}:${mapped.tmdbId}`;
    if (!byTmdb.has(reverseKey)) {
      byTmdb.set(reverseKey, anilistId);
    }
  }

  return { byAnilist, byTmdb };
}

class AnilistIdMapping {
  private syncing = false;
  private byAnilist = new Map<number, AnilistTmdbMapping>();
  private byTmdb = new Map<string, number>();
  private mappingModified: Date | null = null;

  public isLoaded = (): boolean => this.byAnilist.size > 0;

  public getFromAnilistId = (
    anilistId: number
  ): AnilistTmdbMapping | undefined => {
    return this.byAnilist.get(Number(anilistId));
  };

  public getAnilistId = (
    mediaType: 'movie' | 'tv',
    tmdbId: number
  ): number | undefined => {
    return this.byTmdb.get(`${mediaType}:${Number(tmdbId)}`);
  };

  public loadFromEntries = (entries: FribbEntry[]): void => {
    const indexed = indexFribbEntries(entries);
    this.byAnilist = indexed.byAnilist;
    this.byTmdb = indexed.byTmdb;
    this.mappingModified = new Date();
  };

  private loadFromFile = async (): Promise<void> => {
    logger.info('Loading AniList TMDB mapping file', {
      label: 'AniList Mapping',
    });
    try {
      const mappingStat = await fsp.stat(LOCAL_PATH);
      const raw = await fsp.readFile(LOCAL_PATH, 'utf8');
      const parsed = JSON.parse(raw) as FribbEntry[];
      if (!Array.isArray(parsed)) {
        throw new Error('AniList mapping file is not a JSON array');
      }
      this.loadFromEntries(parsed);
      this.mappingModified = mappingStat.mtime;
      logger.info(`Loaded ${this.byAnilist.size} AniList TMDB mappings`, {
        label: 'AniList Mapping',
      });
    } catch (e) {
      throw new Error(
        `Failed to load AniList TMDB mappings: ${
          e instanceof Error ? e.message : 'unknown error'
        }`,
        { cause: e }
      );
    }
  };

  private downloadFile = async (): Promise<void> => {
    logger.info('Downloading latest AniList TMDB mapping file', {
      label: 'AniList Mapping',
    });
    try {
      const response = await axios.get(MAPPING_URL, {
        responseType: 'stream',
      });
      await new Promise<void>((resolve, reject) => {
        const writer = fs.createWriteStream(LOCAL_PATH);
        writer.on('finish', resolve);
        writer.on('error', reject);
        response.data.pipe(writer);
      });
    } catch (e) {
      throw new Error(
        `Failed to download AniList TMDB mapping: ${
          e instanceof Error ? e.message : 'unknown error'
        }`,
        { cause: e }
      );
    }
  };

  public sync = async (): Promise<void> => {
    if (this.syncing) {
      return;
    }

    this.syncing = true;
    try {
      if (fs.existsSync(LOCAL_PATH)) {
        const now = new Date();
        const stat = await fsp.stat(LOCAL_PATH);
        if (now.getTime() - stat.mtime.getTime() < UPDATE_INTERVAL_MSEC) {
          if (!this.isLoaded()) {
            await this.loadFromFile();
          } else if (
            this.mappingModified &&
            stat.mtime.getTime() > this.mappingModified.getTime()
          ) {
            await this.loadFromFile();
          }
          return;
        }
      }
      await this.downloadFile();
      await this.loadFromFile();
    } finally {
      this.syncing = false;
    }
  };
}

const anilistIdMapping = new AnilistIdMapping();

export default anilistIdMapping;
