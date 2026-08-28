import { getRepository } from '@server/datasource';
import { MappingCluster } from '@server/entity/MappingCluster';
import { MappingLink } from '@server/entity/MappingLink';
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
    .orderBy('link.confidence', 'DESC')
    .getRawMany<{ clusterId: number }>();
  return [...new Set(rows.map((row) => row.clusterId))];
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
  return rows.map((row) => ({
    clusterId: row.clusterId,
    namespace: row.namespace,
    externalId: row.externalId,
    season: seasonValue(row.season),
    confidence: row.confidence,
    sourceKey: row.sourceKey,
  }));
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
  return links
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

/**
 * Attach a set of ids to one cluster, merging into an existing cluster when any
 * of the ids already resolves. Every stored link keeps its own `sourceKey` and
 * `confidence`, so a heuristic guess can never become indistinguishable from a
 * dataset fact after the fact.
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
  let clusterId = [...existing][0];
  if (clusterId === undefined) {
    const created = await clusterRepository.save(
      clusterRepository.create({
        kind: clusterKindFor(refs),
        ...canonicalTmdb(refs),
        title: options.title,
        year: options.year,
        createdAt: now,
        updatedAt: now,
      })
    );
    clusterId = created.id;
  } else {
    const canonical = canonicalTmdb(refs);
    await clusterRepository.update(clusterId, {
      updatedAt: now,
      ...(canonical.canonicalTmdbId ? canonical : {}),
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
