import TheMovieDb from '@server/api/themoviedb';
import {
  cacheNegative,
  isNegativelyCached,
  withBudget,
} from '@server/lib/mapping/budget';
import type {
  MappingCandidate,
  MappingResolver,
  Namespace,
} from '@server/lib/mapping/types';

/**
 * TMDB `/find` accepts only `imdb_id, facebook_id, instagram_id, tvdb_id,
 * tiktok_id, twitter_id, wikidata_id, youtube_id`, and **`tvdb_id` is not
 * supported for movies** (confirmed: a movie's TVDB id returns zero results).
 */
const SUPPORTED_FROM: Partial<Record<Namespace, 'imdb' | 'tvdb'>> = {
  imdb: 'imdb',
  tvdb_show: 'tvdb',
};

export interface TmdbFindResult {
  movies: number[];
  shows: number[];
}

export async function tmdbFind(
  source: 'imdb' | 'tvdb',
  externalId: string,
  tmdb: TheMovieDb = new TheMovieDb()
): Promise<TmdbFindResult> {
  const request = `${source}:${externalId}`;
  if (isNegativelyCached('tmdb-find', request))
    return { movies: [], shows: [] };

  const found = await withBudget('tmdb-find', 'interactive', () =>
    source === 'imdb'
      ? tmdb.getByExternalId({ externalId, type: 'imdb' })
      : tmdb.getByExternalId({ externalId: Number(externalId), type: 'tvdb' })
  );

  const result: TmdbFindResult = {
    movies: (found.movie_results ?? [])
      .map((entry) => entry.id)
      .filter(Boolean),
    shows: (found.tv_results ?? []).map((entry) => entry.id).filter(Boolean),
  };
  if (!result.movies.length && !result.shows.length) {
    cacheNegative('tmdb-find', request);
  }
  return result;
}

/**
 * The cheap, reliable bridge that recovers most of the non-anime failures:
 * IMDB -> TMDB resolved 9/9 of MDBList's documented sample at one request each,
 * with the TMDB key the app already ships.
 */
export function tmdbFindResolver(
  createTmdb: () => TheMovieDb = () => new TheMovieDb()
): MappingResolver {
  return {
    key: 'tmdb-find',
    kind: 'live',
    trust: 85,
    supports: (from, to) => {
      const source = SUPPORTED_FROM[from.ns];
      if (!source) return false;
      if (to !== 'tmdb_movie' && to !== 'tmdb_show') return false;
      // Asking TMDB for a movie by TVDB id is documented not to work.
      return !(source === 'tvdb' && to === 'tmdb_movie');
    },
    resolve: async (from, to): Promise<MappingCandidate[]> => {
      const source = SUPPORTED_FROM[from.ns];
      if (!source) return [];
      const found = await tmdbFind(source, String(from.id), createTmdb());
      const ids = to === 'tmdb_movie' ? found.movies : found.shows;
      return ids.map((id) => ({
        target: { ns: to, id: String(id) },
        confidence: 85,
        sourceKey: `tmdb-find:${source}`,
        via: [from],
      }));
    },
  };
}

/**
 * Confirm an id exists in one specific TMDB namespace.
 *
 * This may only *reject* a candidate. `/movie/{id}` answering 200 is not
 * evidence that the id denotes that movie, which is exactly how a wrong
 * media-type hint rendered a 1949 German film as Attack on Titan.
 */
export async function tmdbIdExists(
  mediaType: 'movie' | 'tv',
  tmdbId: number,
  tmdb: TheMovieDb = new TheMovieDb()
): Promise<boolean> {
  return (await tmdbRecord(mediaType, tmdbId, tmdb)).alive;
}

export interface TmdbProbe {
  alive: boolean;
  /** What TMDB calls it, for a confidence check the caller may run. */
  title?: string;
  originalTitle?: string;
  year?: number;
}

/** The same probe, keeping the record so the caller need not fetch it twice. */
export async function tmdbRecord(
  mediaType: 'movie' | 'tv',
  tmdbId: number,
  tmdb: TheMovieDb = new TheMovieDb()
): Promise<TmdbProbe> {
  const request = `exists:${mediaType}:${tmdbId}`;
  if (isNegativelyCached('tmdb-find', request)) return { alive: false };
  try {
    const record = await withBudget('tmdb-find', 'interactive', async () =>
      mediaType === 'movie'
        ? await tmdb.getMovie({ movieId: tmdbId })
        : await tmdb.getTvShow({ tvId: tmdbId })
    );
    const title =
      'title' in record ? record.title : 'name' in record ? record.name : '';
    const originalTitle =
      'original_title' in record
        ? record.original_title
        : 'original_name' in record
          ? record.original_name
          : undefined;
    const released =
      'release_date' in record ? record.release_date : record.first_air_date;
    const year = Number(String(released ?? '').slice(0, 4));
    return {
      alive: true,
      title,
      originalTitle,
      year: Number.isFinite(year) && year > 0 ? year : undefined,
    };
  } catch {
    // Cached so a dead id is not re-probed on every slider render.
    cacheNegative('tmdb-find', request);
    return { alive: false };
  }
}
