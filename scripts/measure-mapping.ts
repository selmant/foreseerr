/**
 * Measure mapping coverage against the acceptance targets.
 *
 * Runs entirely off the pack layer, so it needs no API keys and no database:
 * it answers "of the ids a discover slider would hand us, how many now reach a
 * TMDB id, and from which pack". Live per-slider rates still have to be read
 * off the mapping health page once the instance has served traffic.
 *
 * Usage: pnpm measure:mapping
 */
import { fetchPack } from '@server/lib/mapping/packs/download';
import {
  parsePack,
  validatePackBody,
  type PackRecord,
} from '@server/lib/mapping/packs/formats';
import {
  BUNDLED_MANIFEST,
  type PackManifestEntry,
} from '@server/lib/mapping/packs/manifest';
import type { Namespace } from '@server/lib/mapping/types';

/** Flagship wrong-poster cases from the plan, by AniList id. */
const FLAGSHIP: { anilist: string; title: string }[] = [
  { anilist: '110277', title: 'Attack on Titan Final Season' },
  { anilist: '163139', title: 'My Hero Academia Final' },
  { anilist: '108632', title: 'Re:Zero Season 2' },
  { anilist: '142329', title: 'Demon Slayer Yuukaku-hen' },
  { anilist: '116674', title: 'Bleach: Thousand-Year Blood War' },
  { anilist: '113415', title: 'Jujutsu Kaisen' },
];

const percent = (part: number, whole: number): string =>
  whole === 0 ? 'n/a' : `${((part / whole) * 100).toFixed(1)}%`;

const has = (record: PackRecord, ns: Namespace): boolean =>
  record.refs.some((ref) => ref.ns === ns);

const idOf = (record: PackRecord, ns: Namespace): string | undefined =>
  record.refs.find((ref) => ref.ns === ns)?.id;

async function load(entry: PackManifestEntry): Promise<PackRecord[]> {
  const fetched = await fetchPack({
    key: entry.key,
    format: entry.format,
    mirrors: entry.mirrors,
    validate: (body) => validatePackBody(entry.format, body),
  });
  if (!fetched.body) return [];
  const { records } = await parsePack(entry.format, fetched.body, {
    fieldMap: entry.fieldMap,
    typeFields: entry.typeFields,
    namespaceMap: entry.namespaceMap,
  });
  return records;
}

async function main(): Promise<void> {
  // The union across packs is what the graph ends up holding, so coverage is
  // reported per pack and combined.
  const combined = new Map<string, Set<Namespace>>();
  const rows: string[] = [];

  for (const entry of BUNDLED_MANIFEST.packs) {
    let records: PackRecord[] = [];
    try {
      records = await load(entry);
    } catch (error) {
      rows.push(
        `${entry.key.padEnd(12)} unavailable (${error instanceof Error ? error.message : String(error)})`
      );
      continue;
    }

    const anilist = records.filter((record) => has(record, 'anilist'));
    const toTmdb = anilist.filter(
      (record) => has(record, 'tmdb_show') || has(record, 'tmdb_movie')
    );
    const seasonScoped = records.filter((record) =>
      record.refs.some(
        (ref) =>
          (ref.ns === 'tmdb_show' || ref.ns === 'tvdb_show') &&
          ref.season !== undefined
      )
    );
    const episodeRules = records.reduce(
      (total, record) => total + (record.episodeRules?.length ?? 0),
      0
    );

    rows.push(
      [
        entry.key.padEnd(12),
        `${records.length} records`.padEnd(18),
        `anilist ${anilist.length}`.padEnd(16),
        `→tmdb ${percent(toTmdb.length, anilist.length)}`.padEnd(16),
        `season-scoped ${seasonScoped.length}`.padEnd(24),
        `episode rules ${episodeRules}`,
      ].join(' ')
    );

    for (const record of records) {
      const anilistId = idOf(record, 'anilist');
      if (!anilistId) continue;
      const existing = combined.get(anilistId) ?? new Set<Namespace>();
      for (const ref of record.refs) existing.add(ref.ns);
      combined.set(anilistId, existing);
    }
  }

  const reachTmdb = [...combined.values()].filter(
    (namespaces) => namespaces.has('tmdb_show') || namespaces.has('tmdb_movie')
  ).length;

  // eslint-disable-next-line no-console
  console.log(rows.join('\n'));
  // eslint-disable-next-line no-console
  console.log(
    `\ncombined: ${combined.size} anilist ids, ${percent(reachTmdb, combined.size)} reach a TMDB id`
  );

  // eslint-disable-next-line no-console
  console.log('\nflagship cases:');
  for (const flagship of FLAGSHIP) {
    const namespaces = combined.get(flagship.anilist);
    const state = !namespaces
      ? 'absent from every pack'
      : namespaces.has('tmdb_show') || namespaces.has('tmdb_movie')
        ? 'resolves to TMDB'
        : `no TMDB edge (${[...namespaces].join(', ')})`;
    // eslint-disable-next-line no-console
    console.log(`  ${flagship.title.padEnd(38)} ${state}`);
  }
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
