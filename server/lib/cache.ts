import {
  CacheBudget,
  WeightedLruCacheStore,
  type CacheStore,
} from '@server/lib/cacheStore';

export type AvailableCacheIds =
  | 'tmdb'
  | 'tmdbscan'
  | 'radarr'
  | 'sonarr'
  | 'rt'
  | 'imdb'
  | 'mdblist'
  | 'github'
  | 'plextv'
  | 'plexwatchlist'
  | 'tvdb'
  | 'trakt'
  | 'anilist';

const DEFAULT_TTL = 300;
export const memoryCacheBudget = new CacheBudget();

export const getMemoryCacheStats = () => memoryCacheBudget.stats();

class Cache {
  public id: AvailableCacheIds;
  public data: CacheStore;
  public name: string;

  constructor(
    id: AvailableCacheIds,
    name: string,
    options: { stdTtl?: number; checkPeriod?: number; maxEntries?: number } = {}
  ) {
    this.id = id;
    this.name = name;
    this.data = new WeightedLruCacheStore(
      memoryCacheBudget,
      options.stdTtl ?? DEFAULT_TTL,
      { maxEntries: options.maxEntries }
    );
  }

  public getStats() {
    return this.data.stats();
  }

  public flush(): void {
    this.data.flush();
  }
}

class CacheManager {
  private availableCaches: Record<AvailableCacheIds, Cache> = {
    tmdb: new Cache('tmdb', 'The Movie Database API', {
      stdTtl: 21600,
      checkPeriod: 60 * 30,
    }),
    tmdbscan: new Cache('tmdbscan', 'The Movie Database API (Library Scans)', {
      stdTtl: 900,
      maxEntries: 2000,
    }),
    radarr: new Cache('radarr', 'Radarr API'),
    sonarr: new Cache('sonarr', 'Sonarr API'),
    rt: new Cache('rt', 'Rotten Tomatoes API', {
      stdTtl: 43200,
      checkPeriod: 60 * 30,
    }),
    imdb: new Cache('imdb', 'IMDB Radarr Proxy', {
      stdTtl: 43200,
      checkPeriod: 60 * 30,
    }),
    mdblist: new Cache('mdblist', 'MDBList API', {
      stdTtl: 86400 * 2, // 48h — ratings move slowly; saves daily quota
      checkPeriod: 60 * 30,
    }),
    github: new Cache('github', 'GitHub API', {
      stdTtl: 21600,
      checkPeriod: 60 * 30,
    }),
    plextv: new Cache('plextv', 'Plex TV', {
      stdTtl: 86400 * 7, // 1 week cache
      checkPeriod: 60,
    }),
    plexwatchlist: new Cache('plexwatchlist', 'Plex Watchlist'),
    tvdb: new Cache('tvdb', 'The TVDB API', {
      stdTtl: 21600,
      checkPeriod: 60 * 30,
    }),
    trakt: new Cache('trakt', 'Trakt API', {
      stdTtl: 300,
      checkPeriod: 60,
    }),
    anilist: new Cache('anilist', 'AniList API', {
      stdTtl: 300,
      checkPeriod: 60,
    }),
  };

  public getCache(id: AvailableCacheIds): Cache {
    return this.availableCaches[id];
  }

  public getAllCaches(): Record<string, Cache> {
    return this.availableCaches;
  }
}

const cacheManager = new CacheManager();

export default cacheManager;
