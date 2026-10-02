import TheMovieDb from '@server/api/themoviedb';
import { BoundedLru } from './lru';

/**
 * Confirmed not-founds. Re-asking TMDB for an id it does not have on every
 * slider render is pure waste, but the entry expires so a record created later
 * is picked up without a restart.
 */
const NEGATIVE_TTL_MSEC = 6 * 3600 * 1000;
const negative = new BoundedLru<string, true>(50_000, NEGATIVE_TTL_MSEC);

export const clearTmdbNegativeCache = (): void => negative.clear();

export interface TmdbFindResult {
  movies: number[];
  shows: number[];
}

/**
 * TMDB `/find` accepts only `imdb_id, facebook_id, instagram_id, tvdb_id,
 * tiktok_id, twitter_id, wikidata_id, youtube_id`, and **`tvdb_id` is not
 * supported for movies** (confirmed: a movie's TVDB id returns zero results).
 */
export async function tmdbFind(
  source: 'imdb' | 'tvdb',
  externalId: string,
  tmdb: TheMovieDb = new TheMovieDb()
): Promise<TmdbFindResult> {
  const request = `find:${source}:${externalId}`;
  if (negative.has(request)) return { movies: [], shows: [] };

  const found =
    source === 'imdb'
      ? await tmdb.getByExternalId({ externalId, type: 'imdb' })
      : await tmdb.getByExternalId({
          externalId: Number(externalId),
          type: 'tvdb',
        });

  const result: TmdbFindResult = {
    movies: (found.movie_results ?? [])
      .map((entry) => entry.id)
      .filter(Boolean),
    shows: (found.tv_results ?? []).map((entry) => entry.id).filter(Boolean),
  };
  if (!result.movies.length && !result.shows.length) {
    negative.set(request, true);
  }
  return result;
}

export interface TmdbProbe {
  alive: boolean;
  /** What TMDB calls it, for a confidence check the caller may run. */
  title?: string;
  originalTitle?: string;
  year?: number;
  /** Bare TMDB path (`/abc.jpg`). List tiles need this; `/movie/{id}` already paid for it. */
  posterPath?: string;
  /** Bare TMDB backdrop path, from the same response. */
  backdropPath?: string;
  /** `YYYY-MM-DD`; set for movies. */
  releaseDate?: string;
  /** `YYYY-MM-DD`; set for series. */
  firstAirDate?: string;
}

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * TMDB wraps axios failures as `Error` with `cause` set to the original
 * axios error. Walk that chain so a confirmed 404 is distinguishable from a
 * timeout, 429, or 5xx.
 */
function httpStatus(error: unknown): number | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current != null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const status = (current as { response?: { status?: unknown } }).response
      ?.status;
    if (typeof status === 'number') return status;
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

/**
 * Fetch one record from one specific TMDB namespace.
 *
 * Existence may only *reject* a candidate. `/movie/{id}` answering 200 is not
 * evidence that the id denotes that movie, which is exactly how a wrong
 * media-type hint rendered a 1949 German film as Attack on Titan.
 */
export async function tmdbRecord(
  mediaType: 'movie' | 'tv',
  tmdbId: number,
  tmdb: TheMovieDb = new TheMovieDb()
): Promise<TmdbProbe> {
  const request = `exists:${mediaType}:${tmdbId}`;
  if (negative.has(request)) return { alive: false };
  try {
    const record =
      mediaType === 'movie'
        ? await tmdb.getMovie({ movieId: tmdbId })
        : await tmdb.getTvShow({ tvId: tmdbId });
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
    const posterPath = nonEmpty(record.poster_path);
    const backdropPath = nonEmpty(record.backdrop_path);
    const date = nonEmpty(released);
    return {
      alive: true,
      title,
      originalTitle,
      year: Number.isFinite(year) && year > 0 ? year : undefined,
      ...(posterPath ? { posterPath } : {}),
      ...(backdropPath ? { backdropPath } : {}),
      ...(date
        ? mediaType === 'movie'
          ? { releaseDate: date }
          : { firstAirDate: date }
        : {}),
    };
  } catch (error) {
    // Only a confirmed 404 is a dead id. Timeouts, 429, 5xx, and credential
    // errors must not be sticky-cached as misses.
    if (httpStatus(error) === 404) {
      negative.set(request, true);
      return { alive: false };
    }
    throw error;
  }
}
