import { getRepository } from '@server/datasource';
import { MappingEdge } from '@server/entity/MappingEdge';
import {
  datasetRank,
  ensureMappingLayer,
  isActiveEdge,
  onDatasetsChanged,
} from './datasets';
import { BoundedLru } from './lru';
import {
  scopeSeason,
  seasonScope,
  tmdbNamespace,
  type IdRef,
  type MediaType,
  type Namespace,
} from './types';

export type Edge = Pick<
  MappingEdge,
  | 'dataset'
  | 'srcNs'
  | 'srcId'
  | 'srcScope'
  | 'dstNs'
  | 'dstId'
  | 'dstScope'
  | 'srcRange'
  | 'dstRange'
>;

const cache = new BoundedLru<string, Edge[]>(20_000, 15 * 60 * 1000);
onDatasetsChanged(() => cache.clear());

export const clearEdgeCache = (): void => cache.clear();

/** Every statement about one source id, across the enabled datasets. */
export async function edgesFrom(ns: Namespace, id: string): Promise<Edge[]> {
  // Which rows are readable is only known once the datasets' state is loaded;
  // filtering before that would cache an empty answer for a known id.
  await ensureMappingLayer();
  const key = `${ns}:${id}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const edges = (
    await getRepository(MappingEdge).find({ where: { srcNs: ns, srcId: id } })
  ).filter((row) => isActiveEdge(row.dataset, row.generation));
  cache.set(key, edges);
  return edges;
}

/**
 * The edges that answer for one target namespace: for each source scope, those
 * of the best-ranked dataset that reaches it.
 *
 * A lower-ranked dataset only fills what the primary lacks. Mixing two
 * datasets' answers to the same question is how copies of one fact used to
 * look like disagreement. The choice is made per scope so that a show whose
 * older seasons the primary knows still gets its newest season from the
 * dataset that has it.
 */
export function edgesTo(edges: Edge[], ns: Namespace): Edge[] {
  const best = new Map<string, number>();
  const reaching = edges.filter((edge) => edge.dstNs === ns);
  for (const edge of reaching) {
    const rank = datasetRank(edge.dataset);
    if (rank < (best.get(edge.srcScope) ?? Infinity)) {
      best.set(edge.srcScope, rank);
    }
  }
  return reaching.filter(
    (edge) => datasetRank(edge.dataset) === best.get(edge.srcScope)
  );
}

/**
 * Edges for a reference, narrowed to its season when it names one.
 *
 * AniDB sources prefer the regular-episode scope: the specials scope points at
 * films and season-0 entries that are not the work itself.
 */
export async function edgesFor(ref: IdRef): Promise<Edge[]> {
  const edges = await edgesFrom(ref.ns, String(ref.id));
  if (ref.season !== undefined) {
    const scope = seasonScope(ref.season);
    return edges.filter((edge) => edge.srcScope === scope);
  }
  if (ref.ns === 'anidb') {
    const regular = edges.filter((edge) => edge.srcScope === 'R');
    if (regular.length) return regular;
  }
  return edges;
}

export interface EdgeTarget {
  id: string;
  /** Set when every edge to this id names the same season. */
  season?: number;
}

/** Distinct ids the edges reach in one namespace. */
export function targetsIn(edges: Edge[], ns: Namespace): EdgeTarget[] {
  const scopes = new Map<string, Set<string>>();
  for (const edge of edgesTo(edges, ns)) {
    const seen = scopes.get(edge.dstId) ?? new Set<string>();
    seen.add(edge.dstScope);
    scopes.set(edge.dstId, seen);
  }
  return [...scopes].map(([id, seen]) => {
    const season = seen.size === 1 ? scopeSeason([...seen][0]) : undefined;
    return { id, ...(season === undefined ? {} : { season }) };
  });
}

export interface DatasetTmdb {
  tmdbId: number;
  mediaType: MediaType;
  season?: number;
}

const ENTRY_NAMESPACES: Namespace[] = ['anilist', 'mal', 'anidb'];

const single = (
  edges: Edge[],
  mediaType: MediaType
): DatasetTmdb | undefined => {
  const targets = targetsIn(edges, tmdbNamespace(mediaType));
  // Two different works is a question, not an answer; later steps may settle it.
  if (targets.length !== 1) return undefined;
  const tmdbId = Number(targets[0].id);
  if (!(tmdbId > 0)) return undefined;
  return {
    tmdbId,
    mediaType,
    ...(targets[0].season === undefined ? {} : { season: targets[0].season }),
  };
};

/** The same anime entry under its other ids: MAL, or AniDB regular episodes. */
async function pivotEdges(ref: IdRef, edges: Edge[]): Promise<Edge[]> {
  if (!ENTRY_NAMESPACES.includes(ref.ns)) return [];
  const pivots = new Map<string, IdRef>();
  for (const edge of edges) {
    const isEntry =
      edge.dstNs !== ref.ns &&
      (edge.dstNs === 'mal' ||
        edge.dstNs === 'anilist' ||
        (edge.dstNs === 'anidb' && edge.dstScope === 'R'));
    if (isEntry) {
      pivots.set(`${edge.dstNs}:${edge.dstId}`, {
        ns: edge.dstNs as Namespace,
        id: edge.dstId,
      });
    }
  }
  const out: Edge[] = [];
  for (const pivot of pivots.values()) out.push(...(await edgesFor(pivot)));
  return out;
}

/**
 * What the datasets say this id is on TMDB.
 *
 * The declared media type picks the namespace; with none declared a show is
 * tried first. `crossType` also accepts an answer of the other type, which is
 * safe here because the edge names its namespace explicitly: an OVA filed on
 * TMDB as a film, or a film filed under a show's specials.
 */
export async function datasetTmdb(
  ref: IdRef,
  mediaType?: MediaType,
  options: { crossType?: boolean } = {}
): Promise<DatasetTmdb | undefined> {
  const edges = await edgesFor(ref);
  if (!edges.length) return undefined;
  // A TVDB show id is a show: a film parked in its specials is not the answer.
  const fixed: MediaType | undefined =
    ref.ns === 'tvdb_show'
      ? 'tv'
      : ref.ns === 'tvdb_movie'
        ? 'movie'
        : undefined;
  if (fixed && mediaType && mediaType !== fixed) return undefined;
  const wanted: MediaType[] = fixed
    ? [fixed]
    : mediaType
      ? [mediaType]
      : ['tv', 'movie'];

  const crosses =
    Boolean(options.crossType) && ENTRY_NAMESPACES.includes(ref.ns);
  for (const type of wanted) {
    const direct = single(edges, type);
    if (!direct) continue;
    // An anime entry that only sits in a show's specials and is a film on TMDB
    // of its own is the film, whatever the source called it.
    if (crosses && direct.mediaType === 'tv' && direct.season === 0) {
      const film = single(edges, 'movie');
      if (film) return film;
    }
    return direct;
  }
  const pivoted = await pivotEdges(ref, edges);
  for (const type of wanted) {
    const viaPivot = single(pivoted, type);
    if (viaPivot) return viaPivot;
  }
  // Only an anime entry may cross: its edge names the one work it is.
  if (mediaType && crosses) {
    return single(edges, mediaType === 'movie' ? 'tv' : 'movie');
  }
  return undefined;
}
