import { getRepository } from '@server/datasource';
import { MappingCluster } from '@server/entity/MappingCluster';
import { MappingEpisodeRule } from '@server/entity/MappingEpisodeRule';
import { MappingLink } from '@server/entity/MappingLink';
import { MappingSource } from '@server/entity/MappingSource';
import { In } from 'typeorm';
import {
  clusterKindForNamespace,
  seasonColumn,
  seasonValue,
  tmdbMediaType,
  type ClusterKind,
  type IdRef,
  type MappingCandidate,
  type Namespace,
} from './types';

const disabledSourceKeys = new Set<string>();

export const setMappingSourceEnabled = (
  key: string,
  enabled: boolean
): void => {
  if (enabled) disabledSourceKeys.delete(key);
  else disabledSourceKeys.add(key);
};

export const resetMappingSourceEnabledState = (): void => {
  disabledSourceKeys.clear();
};

export const mappingSourceContributes = (sourceKey: string): boolean => {
  if (disabledSourceKeys.has(sourceKey)) return false;
  for (const key of disabledSourceKeys) {
    if (sourceKey.startsWith(`${key}:`)) return false;
  }
  return true;
};

export async function loadMappingSourceEnabledState(): Promise<string[]> {
  disabledSourceKeys.clear();
  try {
    const rows = await getRepository(MappingSource).find({
      where: { enabled: false },
    });
    for (const row of rows) disabledSourceKeys.add(row.key);
    return rows.map((row) => row.key);
  } catch {
    return [];
  }
}

export interface LinkRecord {
  clusterId: number;
  namespace: Namespace;
  externalId: string;
  season?: number;
  confidence: number;
  sourceKey: string;
}

/**
 * Links whose season matches the query, plus whole-work links.
 *
 * A season-less query matches every season of that id, because callers such as
 * a discover tile legitimately ask "what work is this" without a season; a
 * season-scoped query must not pick up a sibling season, which is exactly the
 * many-to-one collision that made 4,066 anime entries resolve to the wrong show.
 */
export async function findClusterIds(from: IdRef): Promise<number[]> {
  const query = getRepository(MappingLink)
    .createQueryBuilder('link')
    .select('link.clusterId', 'clusterId')
    .where('link.namespace = :ns', { ns: from.ns })
    .andWhere('link.externalId = :id', { id: String(from.id) });
  if (from.season !== undefined) {
    query.andWhere('link.season IN (:...seasons)', {
      seasons: [seasonColumn(from.season), -1],
    });
  }
  const rows = await query
    .addSelect('link.sourceKey', 'sourceKey')
    .orderBy('link.confidence', 'DESC')
    .getRawMany<{ clusterId: number; sourceKey: string }>();
  return [
    ...new Set(
      rows
        .filter((row) => mappingSourceContributes(row.sourceKey))
        .map((row) => row.clusterId)
    ),
  ];
}

export async function findLinks(
  clusterIds: number[],
  namespace: Namespace
): Promise<LinkRecord[]> {
  if (!clusterIds.length) return [];
  const rows = await getRepository(MappingLink).find({
    where: { clusterId: In(clusterIds), namespace },
    order: { confidence: 'DESC' },
  });
  return rows
    .filter((row) => mappingSourceContributes(row.sourceKey))
    .map((row) => ({
      clusterId: row.clusterId,
      namespace: row.namespace,
      externalId: row.externalId,
      season: seasonValue(row.season),
      confidence: row.confidence,
      sourceKey: row.sourceKey,
    }));
}

/**
 * Pack ingest sometimes unions a whole franchise into one cluster (Bleach TV +
 * movies + a stray Clannad season-0 edge; Gintama + Semi-Final). Discover asks
 * "which show is this anilist id" without a season — prefer a whole-work link
 * and, when that still leaves several works, the unique confidence leader.
 *
 * Equal-confidence disagreements stay multi-candidate so MappingService can
 * mark them ambiguous.
 */
export function disambiguateFranchiseCandidates(
  candidates: MappingCandidate[]
): MappingCandidate[] {
  if (candidates.length <= 1) return candidates;

  const byWork = new Map<string, MappingCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.target.ns}:${candidate.target.id}`;
    const bucket = byWork.get(key);
    if (bucket) bucket.push(candidate);
    else byWork.set(key, [candidate]);
  }
  if (byWork.size <= 1) return candidates;

  const withBare = [...byWork.entries()].filter(([, group]) =>
    group.some((candidate) => candidate.target.season === undefined)
  );
  const pool = withBare.length > 0 ? withBare : [...byWork.entries()];
  if (pool.length === 1) return pool[0][1];

  const ranked = pool
    .map(([key, group]) => ({
      key,
      group,
      confidence: Math.max(...group.map((candidate) => candidate.confidence)),
    }))
    .sort((a, b) => b.confidence - a.confidence);

  if (ranked[0].confidence > ranked[1].confidence) {
    return ranked[0].group;
  }
  return candidates;
}

/**
 * Resolve through the stored graph. Candidates are returned rather than a single
 * answer so a one-to-many (a Trakt show TMDB split into per-cour series) surfaces
 * as an ambiguity instead of silently picking the first row.
 */
export async function resolveFromGraph(
  from: IdRef,
  to: Namespace
): Promise<MappingCandidate[]> {
  const clusterIds = await findClusterIds(from);
  if (!clusterIds.length) return [];
  const links = await findLinks(clusterIds, to);
  const wantedSeason = from.season;
  const candidates = links
    .filter((link) => {
      if (wantedSeason === undefined) return true;
      // A season-scoped question may be answered by a whole-work link.
      return link.season === undefined || link.season === wantedSeason;
    })
    .map((link) => ({
      target: {
        ns: link.namespace,
        id: link.externalId,
        ...(link.season === undefined ? {} : { season: link.season }),
      },
      confidence: link.confidence,
      sourceKey: link.sourceKey,
      via: [from],
    }));
  // Season-scoped questions must keep sibling works visible; only the
  // season-less discover path collapses franchise pollution.
  if (wantedSeason !== undefined) return candidates;
  return disambiguateFranchiseCandidates(candidates);
}

export interface UpsertLink {
  ref: IdRef;
  confidence: number;
  sourceKey: string;
}

const clusterKindFor = (refs: IdRef[]): ClusterKind => {
  for (const ref of refs) {
    const kind = clusterKindForNamespace(ref.ns);
    if (kind) return kind;
  }
  return 'series';
};

const canonicalTmdb = (
  refs: IdRef[]
): { canonicalTmdbId?: number; canonicalTmdbType?: 'movie' | 'tv' } => {
  for (const ref of refs) {
    const mediaType = tmdbMediaType(ref.ns);
    if (mediaType && Number(ref.id) > 0) {
      return { canonicalTmdbId: Number(ref.id), canonicalTmdbType: mediaType };
    }
  }
  return {};
};

const sameCanonicalTmdb = (
  cluster: MappingCluster,
  incoming: { canonicalTmdbId?: number; canonicalTmdbType?: 'movie' | 'tv' }
): boolean => {
  if (!incoming.canonicalTmdbId || !cluster.canonicalTmdbId) return true;
  return (
    cluster.canonicalTmdbId === incoming.canonicalTmdbId &&
    cluster.canonicalTmdbType === incoming.canonicalTmdbType
  );
};

/**
 * Attach a set of ids to one cluster, merging into an existing cluster when any
 * of the ids already resolves — but never into a cluster of the opposite kind
 * or a different TMDB work. Sharing an AniDB/MAL id across a franchise used to
 * union films and sibling series onto one cluster, so one AniList id resolved
 * to dozens of TMDB shows.
 *
 * Every stored link keeps its own `sourceKey` and `confidence`, so a heuristic
 * guess can never become indistinguishable from a dataset fact after the fact.
 */
export async function upsertCluster(
  links: UpsertLink[],
  options: { title?: string; year?: number } = {}
): Promise<number | undefined> {
  if (!links.length) return undefined;
  const clusterRepository = getRepository(MappingCluster);
  const linkRepository = getRepository(MappingLink);
  const now = new Date();

  const existing = new Set<number>();
  for (const link of links) {
    for (const clusterId of await findClusterIds(link.ref)) {
      existing.add(clusterId);
    }
  }

  const refs = links.map((link) => link.ref);
  const incomingKind = clusterKindFor(refs);
  const incomingCanonical = canonicalTmdb(refs);

  let clusterId: number | undefined;
  if (existing.size) {
    const clusters = await clusterRepository.find({
      where: { id: In([...existing]) },
    });
    const compatible = clusters.filter(
      (cluster) =>
        cluster.kind === incomingKind &&
        sameCanonicalTmdb(cluster, incomingCanonical)
    );
    clusterId = compatible[0]?.id;
  }

  if (clusterId === undefined) {
    const created = await clusterRepository.save(
      clusterRepository.create({
        kind: incomingKind,
        ...incomingCanonical,
        title: options.title,
        year: options.year,
        createdAt: now,
        updatedAt: now,
      })
    );
    clusterId = created.id;
  } else {
    const cluster = await clusterRepository.findOneBy({ id: clusterId });
    await clusterRepository.update(clusterId, {
      updatedAt: now,
      ...(!cluster?.canonicalTmdbId && incomingCanonical.canonicalTmdbId
        ? incomingCanonical
        : {}),
      ...(options.title ? { title: options.title } : {}),
      ...(options.year ? { year: options.year } : {}),
    });
  }

  for (const link of links) {
    const identity = {
      namespace: link.ref.ns,
      externalId: String(link.ref.id),
      season: seasonColumn(link.ref.season),
      clusterId,
      sourceKey: link.sourceKey,
    };
    const current = await linkRepository.findOne({ where: identity });
    if (!current) {
      await linkRepository.insert({
        ...identity,
        confidence: link.confidence,
        sourceKey: link.sourceKey,
        createdAt: now,
        updatedAt: now,
      });
      continue;
    }
    // Never downgrade a stored link: a lower-confidence source arriving later
    // must not overwrite a better one.
    if (link.confidence > current.confidence) {
      await linkRepository.update(current.id, {
        confidence: link.confidence,
        sourceKey: link.sourceKey,
        updatedAt: now,
      });
    }
  }

  return clusterId;
}

let packGraphRewrites = 0;

export const beginPackGraphRewrite = (): void => {
  packGraphRewrites += 1;
};

export const endPackGraphRewrite = (): void => {
  packGraphRewrites = Math.max(0, packGraphRewrites - 1);
};

export const isPackGraphRewriteInFlight = (): boolean => packGraphRewrites > 0;

export const resetPackGraphRewriteState = (): void => {
  packGraphRewrites = 0;
};

/**
 * Drop graph rows that came from one pack so the next ingest can write a
 * corrected target. Live/override rows are identified by other sourceKeys and
 * are left alone.
 */
export async function retractPackFromGraph(sourceKey: string): Promise<void> {
  const match = { sourceKey, prefix: `${sourceKey}:%` };
  await getRepository(MappingEpisodeRule)
    .createQueryBuilder()
    .delete()
    .where('sourceKey = :sourceKey OR sourceKey LIKE :prefix', match)
    .execute();
  await getRepository(MappingLink)
    .createQueryBuilder()
    .delete()
    .where('sourceKey = :sourceKey OR sourceKey LIKE :prefix', match)
    .execute();
  await getRepository(MappingCluster)
    .createQueryBuilder()
    .delete()
    .where(`id NOT IN (SELECT DISTINCT "clusterId" FROM "mapping_link")`)
    .execute();
}
