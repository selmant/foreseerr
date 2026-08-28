import MdblistAPI from '@server/api/mdblist';
import {
  QuotaExceededError,
  budgetFor,
  withBudget,
} from '@server/lib/mapping/budget';
import type { IdRef, Namespace } from '@server/lib/mapping/types';

const PROVIDER: Partial<Record<Namespace, 'imdb' | 'tmdb' | 'tvdb' | 'trakt'>> =
  {
    imdb: 'imdb',
    tmdb_movie: 'tmdb',
    tmdb_show: 'tmdb',
    tvdb_movie: 'tvdb',
    tvdb_show: 'tvdb',
    trakt: 'trakt',
  };

const NAMESPACE_FOR_FIELD: Record<
  'imdb' | 'tmdb' | 'tvdb' | 'trakt',
  (type: 'movie' | 'show') => Namespace
> = {
  imdb: () => 'imdb',
  tmdb: (type) => (type === 'movie' ? 'tmdb_movie' : 'tmdb_show'),
  tvdb: (type) => (type === 'movie' ? 'tvdb_movie' : 'tvdb_show'),
  trakt: () => 'trakt',
};

export interface MdblistBatchResolution {
  from: IdRef;
  refs: IdRef[];
  title?: string;
}

/**
 * Resolve up to `batchSize` ids in one request.
 *
 * `type` is taken from the caller's declared media type and used verbatim; the
 * returned TMDB id is placed in the matching namespace rather than being probed
 * for existence in either.
 */
export async function resolveMdblistBatch(
  refs: IdRef[],
  type: 'movie' | 'show',
  client: MdblistAPI = MdblistAPI.getInstance()
): Promise<MdblistBatchResolution[]> {
  if (!refs.length || !client.isConfigured()) return [];
  const provider = PROVIDER[refs[0].ns];
  if (!provider) return [];
  if (refs.some((ref) => PROVIDER[ref.ns] !== provider)) {
    throw new Error('resolveMdblistBatch requires one namespace per call');
  }

  const batchSize = budgetFor('mdblist-batch').batchSize ?? 200;
  const results: MdblistBatchResolution[] = [];

  for (let index = 0; index < refs.length; index += batchSize) {
    const slice = refs.slice(index, index + batchSize);
    let payloads;
    try {
      payloads = await withBudget('mdblist-batch', 'bulk', () =>
        client.resolveIdsBatch(
          provider,
          type,
          slice.map((ref) => ref.id)
        )
      );
    } catch (error) {
      // Quota is a hard daily stop, not a transient failure: give up on the
      // remaining batches rather than burning retries.
      if (error instanceof QuotaExceededError) break;
      throw error;
    }

    const byInput = new Map(slice.map((ref) => [ref.id.toLowerCase(), ref]));
    for (const payload of payloads) {
      const ids = payload.ids ?? {};
      const refsFound: IdRef[] = [];
      for (const [field, value] of Object.entries(ids)) {
        if (value === undefined || value === null || value === '') continue;
        const namespaceFor =
          NAMESPACE_FOR_FIELD[field as keyof typeof NAMESPACE_FOR_FIELD];
        if (!namespaceFor) continue;
        refsFound.push({ ns: namespaceFor(type), id: String(value) });
      }
      const inputValue = ids[provider];
      const from =
        inputValue !== undefined && inputValue !== null
          ? byInput.get(String(inputValue).toLowerCase())
          : undefined;
      if (!from || refsFound.length < 2) continue;
      results.push({
        from,
        refs: refsFound,
        ...(payload.title ? { title: payload.title } : {}),
      });
    }
  }

  return results;
}
