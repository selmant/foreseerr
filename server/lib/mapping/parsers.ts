/**
 * One directed statement, in the shape it is stored. See `MappingEdge`.
 */
export interface EdgeRow {
  srcNs: string;
  srcId: string;
  srcScope: string;
  dstNs: string;
  dstId: string;
  dstScope: string;
  srcRange?: string;
  dstRange?: string;
}

export interface ParsedDataset {
  edges: EdgeRow[];
  /** Upstream's own build stamp, when the file carries one. */
  version?: string;
}

interface Descriptor {
  ns: string;
  id: string;
  scope: string;
}

/**
 * anibridge writes `imdb_movie` and `imdb_show`; an IMDb id is unique across
 * both, so they share one namespace here. Any provider not listed is skipped.
 */
const ANIBRIDGE_PROVIDERS: Record<string, string> = {
  anidb: 'anidb',
  anilist: 'anilist',
  mal: 'mal',
  imdb_movie: 'imdb',
  imdb_show: 'imdb',
  tmdb_movie: 'tmdb_movie',
  tmdb_show: 'tmdb_show',
  tvdb_movie: 'tvdb_movie',
  tvdb_show: 'tvdb_show',
};

/** `provider:id[:scope]`, e.g. `tmdb_show:1429:s1` or `anidb:9541:R`. */
export function parseDescriptor(token: string): Descriptor | undefined {
  const [provider, id, scope] = token.split(':');
  const ns = ANIBRIDGE_PROVIDERS[provider];
  if (!ns || !id) return undefined;
  return { ns, id, scope: scope ?? '' };
}

/**
 * anibridge-mappings v3: each key is a source descriptor, each value maps
 * target descriptors to `{ sourceRange: targetRange }`.
 *
 *   "anilist:1225": { "tmdb_show:62913:s2": { "1-3": "1-3" } }
 *
 * The file states every direction it vouches for, so each pair becomes one row
 * and nothing is inferred.
 */
export function parseAnibridge(body: string): ParsedDataset {
  const parsed: unknown = JSON.parse(body);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('anibridge dataset is not an object');
  }
  const { $meta: meta, ...graph } = parsed as Record<string, unknown>;

  const edges: EdgeRow[] = [];
  for (const [sourceToken, targets] of Object.entries(graph)) {
    const source = parseDescriptor(sourceToken);
    if (!source || !targets || typeof targets !== 'object') continue;
    for (const [targetToken, ranges] of Object.entries(
      targets as Record<string, unknown>
    )) {
      const target = parseDescriptor(targetToken);
      if (!target) continue;
      const base = {
        srcNs: source.ns,
        srcId: source.id,
        srcScope: source.scope,
        dstNs: target.ns,
        dstId: target.id,
        dstScope: target.scope,
      };
      const pairs =
        ranges && typeof ranges === 'object'
          ? Object.entries(ranges as Record<string, unknown>).filter(
              (pair): pair is [string, string] => typeof pair[1] === 'string'
            )
          : [];
      if (!pairs.length) {
        edges.push(base);
        continue;
      }
      for (const [srcRange, dstRange] of pairs) {
        edges.push({ ...base, srcRange, dstRange });
      }
    }
  }

  const generatedOn =
    meta && typeof meta === 'object'
      ? (meta as { generated_on?: unknown }).generated_on
      : undefined;
  return {
    edges,
    ...(typeof generatedOn === 'string' ? { version: generatedOn } : {}),
  };
}

const positiveInt = (value: unknown): string | undefined => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? String(parsed) : undefined;
};

const seasonOf = (value: unknown): string =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? `s${value}`
    : '';

const SERIES_TYPES = new Set(['TV', 'ONA']);

/**
 * Fribb/anime-lists `anime-list-full.json`: one flat record per anime entry.
 *
 *   { "type": "TV", "anilist_id": 290, "mal_id": 290, "anidb_id": 1,
 *     "themoviedb_id": { "tv": 26209 }, "tvdb_id": 72025,
 *     "season": { "tvdb": 1, "tmdb": 1 }, "episode_offset": { "tmdb": 2 } }
 *
 * `themoviedb_id` can carry both a show and films. The row's `type` decides
 * which one this entry is; taking both is how a series entry grew a movie edge.
 * A range is only stated when the row carries an explicit offset.
 */
export function parseFribb(body: string): ParsedDataset {
  const parsed: unknown = JSON.parse(body);
  if (!Array.isArray(parsed)) {
    throw new Error('fribb dataset is not an array');
  }

  const edges: EdgeRow[] = [];
  for (const entry of parsed as unknown[]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;

    const sources: Descriptor[] = [];
    const anilist = positiveInt(row.anilist_id);
    const mal = positiveInt(row.mal_id);
    const anidb = positiveInt(row.anidb_id);
    if (anilist) sources.push({ ns: 'anilist', id: anilist, scope: '' });
    if (mal) sources.push({ ns: 'mal', id: mal, scope: '' });
    if (anidb) sources.push({ ns: 'anidb', id: anidb, scope: 'R' });
    if (!sources.length) continue;

    const type = typeof row.type === 'string' ? row.type.toUpperCase() : '';
    const tmdb =
      row.themoviedb_id && typeof row.themoviedb_id === 'object'
        ? (row.themoviedb_id as { tv?: unknown; movie?: unknown })
        : {};
    const season =
      row.season && typeof row.season === 'object'
        ? (row.season as { tmdb?: unknown; tvdb?: unknown })
        : {};
    const offset =
      row.episode_offset && typeof row.episode_offset === 'object'
        ? (row.episode_offset as { tmdb?: unknown; tvdb?: unknown })
        : {};

    const show = positiveInt(tmdb.tv);
    const movies = (Array.isArray(tmdb.movie) ? tmdb.movie : [tmdb.movie])
      .map(positiveInt)
      .filter((id): id is string => id !== undefined);

    const targets: (Descriptor & { offset?: number })[] = [];
    const wantsMovie = type === 'MOVIE' || (!show && !SERIES_TYPES.has(type));
    if (show && !(type === 'MOVIE' && movies.length)) {
      targets.push({
        ns: 'tmdb_show',
        id: show,
        scope: seasonOf(season.tmdb),
        offset: Number(offset.tmdb),
      });
    }
    // Several films under one entry is a collection, not an answer.
    if (wantsMovie && movies.length === 1) {
      targets.push({ ns: 'tmdb_movie', id: movies[0], scope: '' });
    }
    const tvdb = positiveInt(row.tvdb_id);
    if (tvdb) {
      targets.push({
        ns: 'tvdb_show',
        id: tvdb,
        scope: seasonOf(season.tvdb),
        offset: Number(offset.tvdb),
      });
    }
    const imdb = Array.isArray(row.imdb_id) ? row.imdb_id : [row.imdb_id];
    if (imdb.length === 1 && typeof imdb[0] === 'string' && imdb[0]) {
      targets.push({ ns: 'imdb', id: imdb[0], scope: '' });
    }

    for (const source of sources) {
      for (const { offset: by, ...target } of targets) {
        const ranged = Number.isInteger(by) && (by as number) > 0;
        const forward: EdgeRow = {
          srcNs: source.ns,
          srcId: source.id,
          srcScope: source.scope,
          dstNs: target.ns,
          dstId: target.id,
          dstScope: target.scope,
          ...(ranged
            ? { srcRange: '1-', dstRange: `${(by as number) + 1}-` }
            : {}),
        };
        edges.push(forward);
        // Sync asks the other way round: which entry is this show's season.
        edges.push({
          srcNs: forward.dstNs,
          srcId: forward.dstId,
          srcScope: forward.dstScope,
          dstNs: forward.srcNs,
          dstId: forward.srcId,
          dstScope: forward.srcScope,
          ...(ranged
            ? { srcRange: forward.dstRange, dstRange: forward.srcRange }
            : {}),
        });
      }
    }
  }
  return { edges };
}
