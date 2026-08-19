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

interface FribbSeason {
  tvdb?: number | string;
  tmdb?: number | string;
}

interface FribbEpisodeOffset {
  tvdb?: number | string;
  tmdb?: number | string;
}

interface FribbEntry {
  type?: string;
  anilist_id?: number;
  themoviedb_id?: FribbTmdbIds;
  season?: FribbSeason;
  episode_offset?: FribbEpisodeOffset;
}

const SERIES_FRIBB_TYPES = new Set(['TV', 'ONA', 'TV_SHORT']);

export interface AnilistSeasonMapping {
  anilistId: number;
  type?: string;
  seasonTmdb: number | null;
  seasonTvdb: number | null;
  offsetTmdb: number;
  offsetTvdb: number;
}

function parseNonNegativeInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.trunc(parsed);
}

function parseOffset(value: unknown): number {
  return parseNonNegativeInt(value) ?? 0;
}

export function isSeriesFribbType(type?: string | null): boolean {
  return !type || SERIES_FRIBB_TYPES.has(type);
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
  byTmdbAll: Map<string, number[]>;
  byTmdbSeasons: Map<string, AnilistSeasonMapping[]>;
} {
  const byAnilist = new Map<number, AnilistTmdbMapping>();
  const byTmdb = new Map<string, number>();
  const byTmdbAll = new Map<string, number[]>();
  const byTmdbSeasons = new Map<string, AnilistSeasonMapping[]>();

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
    const all = byTmdbAll.get(reverseKey) ?? [];
    if (!all.includes(anilistId)) {
      all.push(anilistId);
      byTmdbAll.set(reverseKey, all);
    }
    const seasonEntries = byTmdbSeasons.get(reverseKey) ?? [];
    if (!seasonEntries.some((item) => item.anilistId === anilistId)) {
      seasonEntries.push({
        anilistId,
        type: entry.type,
        seasonTmdb: parseNonNegativeInt(entry.season?.tmdb),
        seasonTvdb: parseNonNegativeInt(entry.season?.tvdb),
        offsetTmdb: parseOffset(entry.episode_offset?.tmdb),
        offsetTvdb: parseOffset(entry.episode_offset?.tvdb),
      });
      byTmdbSeasons.set(reverseKey, seasonEntries);
    }
  }

  return { byAnilist, byTmdb, byTmdbAll, byTmdbSeasons };
}

function offsetForCatalog(
  entry: AnilistSeasonMapping,
  catalog: 'tmdb' | 'tvdb'
): number {
  return catalog === 'tvdb' ? entry.offsetTvdb : entry.offsetTmdb;
}

export function fribbSeasonCandidates(
  entries: AnilistSeasonMapping[],
  seasonNumber: number
): {
  catalog: 'tmdb' | 'tvdb';
  mode: 'in-season' | 'absolute';
  entries: AnilistSeasonMapping[];
} {
  const series = entries.filter(
    (entry) => isSeriesFribbType(entry.type) && entry.anilistId > 0
  );
  if (seasonNumber < 1 || series.length === 0) {
    return { catalog: 'tmdb', mode: 'in-season', entries: [] };
  }
  if (series.length === 1) {
    return { catalog: 'tmdb', mode: 'absolute', entries: series };
  }

  const tmdbHits = series.filter((entry) => entry.seasonTmdb === seasonNumber);
  const tvdbHits = series.filter((entry) => entry.seasonTvdb === seasonNumber);
  const tmdbSeasons = new Set(
    series
      .map((entry) => entry.seasonTmdb)
      .filter((season): season is number => season != null && season > 0)
  );
  const tvdbSeasons = new Set(
    series
      .map((entry) => entry.seasonTvdb)
      .filter((season): season is number => season != null && season > 0)
  );
  const tmdbCollapsed = tmdbSeasons.size <= 1 && tvdbSeasons.size > 1;
  if (tmdbCollapsed) {
    return { catalog: 'tvdb', mode: 'in-season', entries: tvdbHits };
  }
  if (tmdbHits.length > 0) {
    return { catalog: 'tmdb', mode: 'in-season', entries: tmdbHits };
  }
  return { catalog: 'tvdb', mode: 'in-season', entries: tvdbHits };
}

export function pickFribbSeasonEntry(
  entries: AnilistSeasonMapping[],
  seasonNumber: number,
  episodeNumber: number
): {
  mapping: AnilistSeasonMapping;
  progress: number;
  mode: 'in-season' | 'absolute';
} | null {
  if (episodeNumber < 1) {
    return null;
  }
  const {
    catalog,
    mode,
    entries: hits,
  } = fribbSeasonCandidates(entries, seasonNumber);
  if (hits.length === 0) {
    return null;
  }
  if (mode === 'absolute') {
    return { mapping: hits[0], progress: episodeNumber, mode };
  }
  const sorted = [...hits].sort(
    (left, right) =>
      offsetForCatalog(left, catalog) - offsetForCatalog(right, catalog) ||
      left.anilistId - right.anilistId
  );
  const picked =
    sorted.length === 1
      ? sorted[0]
      : sorted.find((entry, index) => {
          const start = offsetForCatalog(entry, catalog) + 1;
          const next = sorted[index + 1];
          const end = next
            ? offsetForCatalog(next, catalog)
            : Number.POSITIVE_INFINITY;
          return episodeNumber >= start && episodeNumber <= end;
        });
  if (!picked) {
    return null;
  }
  const progress = episodeNumber - offsetForCatalog(picked, catalog);
  if (progress < 1) {
    return null;
  }
  return { mapping: picked, progress, mode };
}

class AnilistIdMapping {
  private syncing = false;
  private byAnilist = new Map<number, AnilistTmdbMapping>();
  private byTmdb = new Map<string, number>();
  private byTmdbAll = new Map<string, number[]>();
  private byTmdbSeasons = new Map<string, AnilistSeasonMapping[]>();
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

  public getAnilistIds = (
    mediaType: 'movie' | 'tv',
    tmdbId: number
  ): number[] => {
    return this.byTmdbAll.get(`${mediaType}:${Number(tmdbId)}`) ?? [];
  };

  public getAnilistSeasonEntries = (
    mediaType: 'movie' | 'tv',
    tmdbId: number
  ): AnilistSeasonMapping[] => {
    return this.byTmdbSeasons.get(`${mediaType}:${Number(tmdbId)}`) ?? [];
  };

  public loadFromEntries = (entries: FribbEntry[]): void => {
    const indexed = indexFribbEntries(entries);
    this.byAnilist = indexed.byAnilist;
    this.byTmdb = indexed.byTmdb;
    this.byTmdbAll = indexed.byTmdbAll;
    this.byTmdbSeasons = indexed.byTmdbSeasons;
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
