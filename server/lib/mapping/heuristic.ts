import TheMovieDb from '@server/api/themoviedb';
import { getRepository } from '@server/datasource';
import { MappingGap } from '@server/entity/MappingGap';
import logger from '@server/logger';
import { withBudget } from './budget';
import { recordMappingGap } from './gaps';
import {
  refKey,
  seasonValue,
  tmdbMediaType,
  type IdRef,
  type MappingCandidate,
  type MappingResolver,
  type Namespace,
  type ResolverContext,
} from './types';

/**
 * L4: match by title, year and episode count when no id-based resolver can
 * answer. Its output is quarantined by design — a previous title-matching
 * attempt was reverted because fuzzy matches were written straight into the
 * graph, where a single bad match then poisoned every downstream lookup. Here
 * the guess only ever lands on a `MappingGap` as a suggestion for an admin to
 * accept or reject.
 */

/** Below this a suggestion is noise and is not even worth reviewing. */
const MIN_SUGGESTION_SCORE = 55;
/** Suggestion confidence is capped so it can never outrank a real source. */
const MAX_SUGGESTION_CONFIDENCE = 40;
const CANDIDATES_CONSIDERED = 5;

/**
 * Strip the decoration that distinguishes releases of the same work across
 * catalogues: season words, ordinal suffixes, punctuation and diacritics.
 */
export const normalizeTitle = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an|season|series|part|cour|tv|anime)\b/g, ' ')
    .replace(/\b(\d+)(st|nd|rd|th)\b/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

/** Levenshtein distance, bounded by the shorter string. */
const editDistance = (a: string, b: string): number => {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[b.length];
};

/** 0-100 similarity of two already-normalized titles. */
export const titleScore = (a: string, b: string): number => {
  if (!a || !b) return 0;
  if (a === b) return 100;
  const longest = Math.max(a.length, b.length);
  const similarity = 1 - editDistance(a, b) / longest;
  // Phrase containment must be token-bounded: "monogatari" inside
  // "owarimonogatari" is a franchise hub hitchhike, not the same work.
  const paddedA = ` ${a} `;
  const paddedB = ` ${b} `;
  const contained = paddedA.includes(paddedB) || paddedB.includes(paddedA);
  return Math.round(Math.max(similarity, contained ? 0.8 : 0) * 100);
};

/**
 * Token overlap for romaji-vs-English pairs that whole-string edit distance
 * thrases (e.g. "Gekijouban … Walpurgis no Kaiten" vs "… Walpurgisnacht: Rising").
 * Tokens ≥4 chars; a token hits if equal, contained, or titleScore ≥80.
 */
export const tokenOverlapScore = (a: string, b: string): number => {
  const tokens = (value: string): string[] =>
    normalizeTitle(value)
      .split(' ')
      .filter((token) => token.length >= 4);
  const left = tokens(a);
  const right = tokens(b);
  if (!left.length || !right.length) return 0;
  let hits = 0;
  for (const token of left) {
    if (
      right.some(
        (other) =>
          other === token ||
          other.startsWith(token) ||
          token.startsWith(other) ||
          titleScore(token, other) >= 80
      )
    ) {
      hits += 1;
    }
  }
  return Math.round((hits / left.length) * 100);
};

/**
 * Year and episode count are gates, not weights. A high title score with the
 * wrong year is exactly the failure mode that produced wrong posters: a strong
 * name match cannot be allowed to outvote hard evidence that this is a
 * different work.
 */
const yearAgrees = (expected?: number, actual?: number): boolean =>
  !expected || !actual || Math.abs(expected - actual) <= 1;

const episodesAgree = (expected?: number, actual?: number): boolean =>
  !expected || !actual || Math.abs(expected - actual) <= 2;

const yearBonus = (expected?: number, actual?: number): number =>
  expected && actual && expected === actual ? 10 : 0;

const yearOf = (date?: string): number | undefined => {
  const year = Number(date?.slice(0, 4));
  return Number.isFinite(year) && year > 1870 ? year : undefined;
};

interface Suggestion {
  target: IdRef;
  score: number;
  reason: string;
}

export interface TitleSearchHit {
  id: number;
  title: string;
  originalTitle?: string;
  year?: number;
}

/** Injected in tests so the guard rails can be exercised without a network. */
export interface TitleSearchProvider {
  search(
    mediaType: 'movie' | 'tv',
    query: string,
    year?: number
  ): Promise<TitleSearchHit[]>;
  episodeCount(tmdbShowId: number): Promise<number | undefined>;
}

export const tmdbTitleSearch = (): TitleSearchProvider => {
  const tmdb = new TheMovieDb();
  return {
    search: (mediaType, query, year) =>
      withBudget('tmdb-find', 'interactive', async () => {
        if (mediaType === 'movie') {
          const { results } = await tmdb.searchMovies({ query, year });
          return results.map((result) => ({
            id: result.id,
            title: result.title ?? '',
            originalTitle: result.original_title,
            year: yearOf(result.release_date),
          }));
        }
        const { results } = await tmdb.searchTvShows({ query, year });
        return results.map((result) => ({
          id: result.id,
          title: result.name ?? '',
          originalTitle: result.original_name,
          year: yearOf(result.first_air_date),
        }));
      }),
    episodeCount: async (tmdbShowId) => {
      try {
        const show = await withBudget('tmdb-find', 'interactive', () =>
          tmdb.getTvShow({ tvId: tmdbShowId })
        );
        return show.number_of_episodes;
      } catch {
        return undefined;
      }
    },
  };
};

function rank(
  hits: TitleSearchHit[],
  context: ResolverContext,
  mediaType: 'movie' | 'tv'
): Suggestion[] {
  const wanted = normalizeTitle(context.title ?? '');
  return hits
    .slice(0, CANDIDATES_CONSIDERED)
    .filter((hit) => yearAgrees(context.year, hit.year))
    .map((hit) => {
      const name = Math.max(
        titleScore(wanted, normalizeTitle(hit.title)),
        titleScore(wanted, normalizeTitle(hit.originalTitle ?? ''))
      );
      return {
        target: {
          ns: (mediaType === 'movie' ? 'tmdb_movie' : 'tmdb_show') as Namespace,
          id: String(hit.id),
        },
        score: name + yearBonus(context.year, hit.year),
        reason: `title ${name}/100, year ${hit.year ?? '?'} vs ${context.year ?? '?'}`,
      };
    })
    .sort((a, b) => b.score - a.score);
}

export async function suggestByTitle(
  from: IdRef,
  to: Namespace,
  context: ResolverContext,
  provider: TitleSearchProvider = tmdbTitleSearch()
): Promise<Suggestion | undefined> {
  const mediaType = tmdbMediaType(to);
  if (!mediaType || !context.title?.trim()) return undefined;

  const ranked = rank(
    await provider.search(mediaType, context.title, context.year),
    context,
    mediaType
  );
  if (!ranked.length) return undefined;

  let best = ranked[0];
  // Episode count is the tiebreaker between a season and a whole series, so it
  // is worth exactly one extra request, against the leading candidate only.
  if (mediaType === 'tv' && context.episodeCount) {
    const actual = await provider.episodeCount(Number(best.target.id));
    if (!episodesAgree(context.episodeCount, actual)) return undefined;
    best = {
      ...best,
      reason: `${best.reason}, episodes ${actual ?? '?'} vs ${context.episodeCount}`,
    };
  }

  // A near-tie means the guess is not distinguishing anything; two plausible
  // titles is exactly the case that produced wrong posters before.
  const runnerUp = ranked[1];
  if (runnerUp && best.score - runnerUp.score < 10) return undefined;
  if (best.score < MIN_SUGGESTION_SCORE) return undefined;

  logger.debug('Heuristic mapping suggestion', {
    label: 'Mapping',
    from: refKey(from),
    to: refKey(best.target),
    score: best.score,
    reason: best.reason,
  });
  return best;
}

/**
 * Available for the chain, but off the read path by default: a suggestion is
 * only ever reviewable output, so paying a TMDB search per slider tile buys
 * nothing a background sweep cannot. When registered it records the suggestion
 * and still returns no candidate, because a heuristic answer must never be
 * served.
 */
export const heuristicResolver = (
  provider: TitleSearchProvider = tmdbTitleSearch()
): MappingResolver => ({
  key: 'heuristic-title',
  kind: 'heuristic',
  trust: 1,
  supports: (_from, to) => tmdbMediaType(to) !== undefined,
  resolve: async (
    from: IdRef,
    to: Namespace,
    context?: ResolverContext
  ): Promise<MappingCandidate[]> => {
    if (!context?.title) return [];
    const suggestion = await suggestByTitle(from, to, context, provider);
    if (!suggestion) return [];

    recordMappingGap({
      namespace: from.ns,
      externalId: String(from.id),
      season: from.season,
      title: context.title,
      year: context.year,
      mediaType: context.mediaType,
      discoverSource: context.discoverSource,
      reason: 'unresolved',
      sourceKey: `resolve->${to}`,
      suggestedTarget: refKey(suggestion.target),
      suggestedConfidence: Math.min(
        MAX_SUGGESTION_CONFIDENCE,
        suggestion.score
      ),
      suggestedBy: 'heuristic-title',
    });
    return [];
  },
});

export interface HeuristicSweepResult {
  examined: number;
  suggested: number;
}

/**
 * Walk the busiest open gaps and attach a suggestion to each. Nothing here
 * writes to the graph: the queue is the only destination, and an admin
 * accepting a row is what turns a guess into a mapping.
 */
export async function suggestForOpenGaps({
  limit = 50,
  provider = tmdbTitleSearch(),
}: {
  limit?: number;
  provider?: TitleSearchProvider;
} = {}): Promise<HeuristicSweepResult> {
  const repository = getRepository(MappingGap);
  const gaps = await repository
    .createQueryBuilder('gap')
    .where('gap.status = :status', { status: 'open' })
    .andWhere('gap.title IS NOT NULL')
    .andWhere('gap.suggestedTarget IS NULL')
    .orderBy('gap.hitCount', 'DESC')
    .addOrderBy('gap.lastSeenAt', 'DESC')
    .take(Math.min(500, Math.max(1, limit)))
    .getMany();

  const result: HeuristicSweepResult = { examined: gaps.length, suggested: 0 };
  for (const gap of gaps) {
    const season = seasonValue(gap.season);
    const from: IdRef = {
      ns: gap.namespace,
      id: gap.externalId,
      ...(season === undefined ? {} : { season }),
    };
    const to: Namespace =
      gap.mediaType === 'movie' ? 'tmdb_movie' : 'tmdb_show';
    try {
      const suggestion = await suggestByTitle(
        from,
        to,
        { title: gap.title, year: gap.year, mediaType: gap.mediaType },
        provider
      );
      if (!suggestion) continue;
      await repository.update(gap.id, {
        suggestedTarget: refKey(suggestion.target),
        suggestedConfidence: Math.min(
          MAX_SUGGESTION_CONFIDENCE,
          suggestion.score
        ),
        suggestedBy: 'heuristic-title',
      });
      result.suggested += 1;
    } catch (error) {
      logger.debug('Heuristic sweep failed for gap', {
        label: 'Mapping',
        gap: refKey(from),
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info('Heuristic mapping sweep finished', {
    label: 'Mapping',
    ...result,
  });
  return result;
}
