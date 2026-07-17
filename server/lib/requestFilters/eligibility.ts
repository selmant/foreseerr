import type { RequestFiltersSettings } from './types';

export class RequestEligibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestEligibilityError';
  }
}

export type EligibilityMediaInput = {
  mediaType: 'movie' | 'tv';
  voteAverage: number;
  voteCount: number;
  releaseYear: number | null;
  genreIds: number[];
  imdbRating?: number | null;
  imdbVotes?: number | null;
  rtCriticsScore?: number | null;
  rtAudienceScore?: number | null;
  metacriticScore?: number | null;
  traktRating?: number | null;
};

export type EligibilityCheckOptions = {
  settings: RequestFiltersSettings;
  media: EligibilityMediaInput;
};

const hasTmdbGate = (settings: RequestFiltersSettings): boolean =>
  settings.tmdbThreshold != null || settings.tmdbMinVotes != null;

const hasImdbGate = (settings: RequestFiltersSettings): boolean =>
  settings.imdbThreshold != null || settings.imdbMinVotes != null;

const checkMissingScore = (
  score: number | null | undefined,
  includeNoRating: boolean,
  label: string
): string | null => {
  if (score != null && Number.isFinite(score)) {
    return null;
  }
  return includeNoRating ? null : `${label} rating is missing.`;
};

const checkMinScore = (
  score: number | null | undefined,
  threshold: number,
  label: string,
  digits: number
): string | null => {
  if (score == null || !Number.isFinite(score)) {
    return null;
  }
  if (score < threshold) {
    return `${label} ${score.toFixed(digits)} is below the minimum of ${threshold}.`;
  }
  return null;
};

const checkTmdb = (
  settings: RequestFiltersSettings,
  media: EligibilityMediaInput
): string | null => {
  if (!hasTmdbGate(settings)) {
    return null;
  }

  const missing =
    !Number.isFinite(media.voteAverage) ||
    media.voteAverage <= 0 ||
    !Number.isFinite(media.voteCount);

  if (missing) {
    return settings.includeNoRating
      ? null
      : 'TMDB rating is missing or incomplete.';
  }

  if (
    settings.tmdbThreshold != null &&
    media.voteAverage < settings.tmdbThreshold
  ) {
    return `TMDB rating ${media.voteAverage.toFixed(1)} is below the minimum of ${settings.tmdbThreshold}.`;
  }

  if (
    settings.tmdbMinVotes != null &&
    media.voteCount < settings.tmdbMinVotes
  ) {
    return `TMDB vote count ${media.voteCount} is below the minimum of ${settings.tmdbMinVotes}.`;
  }

  return null;
};

const checkImdb = (
  settings: RequestFiltersSettings,
  media: EligibilityMediaInput
): string | null => {
  if (!hasImdbGate(settings)) {
    return null;
  }

  const missing = checkMissingScore(
    media.imdbRating,
    settings.includeNoRating,
    'IMDb'
  );
  if (missing) {
    return missing;
  }

  if (settings.imdbThreshold != null) {
    const below = checkMinScore(
      media.imdbRating,
      settings.imdbThreshold,
      'IMDb rating',
      1
    );
    if (below) {
      return below;
    }
  }

  if (
    settings.imdbMinVotes != null &&
    (media.imdbVotes == null || media.imdbVotes < settings.imdbMinVotes)
  ) {
    return `IMDb vote count ${media.imdbVotes ?? 0} is below the minimum of ${settings.imdbMinVotes}.`;
  }

  return null;
};

const checkMdblistScoreGate = (
  threshold: number | null,
  score: number | null | undefined,
  includeNoRating: boolean,
  label: string,
  digits: number
): string | null => {
  if (threshold == null) {
    return null;
  }

  const missing = checkMissingScore(score, includeNoRating, label);
  if (missing) {
    return missing;
  }

  return checkMinScore(score, threshold, `${label} rating`, digits);
};

/**
 * Pure eligibility evaluation for Discover browse.
 * Returns null when the title should be shown, otherwise a reason to hide it.
 */
export const evaluateRequestEligibility = (
  options: EligibilityCheckOptions
): string | null => {
  const { settings, media } = options;

  if (!settings.enabled) {
    return null;
  }

  if (
    settings.excludedGenreIds.length > 0 &&
    media.genreIds.some((id) => settings.excludedGenreIds.includes(id))
  ) {
    return 'Media matches an excluded genre.';
  }

  if (settings.minReleaseYear != null) {
    if (media.releaseYear == null) {
      if (!settings.includeNoRating) {
        return 'Release year is missing.';
      }
    } else if (media.releaseYear < settings.minReleaseYear) {
      return `Release year ${media.releaseYear} is before the minimum of ${settings.minReleaseYear}.`;
    }
  }

  const gates: (string | null)[] = [
    checkTmdb(settings, media),
    checkImdb(settings, media),
    checkMdblistScoreGate(
      settings.rtCriticsThreshold,
      media.rtCriticsScore,
      settings.includeNoRating,
      'Rotten Tomatoes critics',
      0
    ),
    checkMdblistScoreGate(
      settings.rtAudienceThreshold,
      media.rtAudienceScore,
      settings.includeNoRating,
      'Rotten Tomatoes audience',
      0
    ),
    checkMdblistScoreGate(
      settings.metacriticThreshold,
      media.metacriticScore,
      settings.includeNoRating,
      'Metacritic',
      0
    ),
    checkMdblistScoreGate(
      settings.traktThreshold,
      media.traktRating,
      settings.includeNoRating,
      'Trakt community',
      1
    ),
  ];

  return gates.find((reason) => reason != null) ?? null;
};

export const isEligibleForDiscover = (
  settings: RequestFiltersSettings,
  media: EligibilityMediaInput
): boolean => evaluateRequestEligibility({ settings, media }) == null;
