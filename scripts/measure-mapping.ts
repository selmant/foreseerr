/**
 * Measure how much of each mapping dataset reaches TMDB.
 *
 * Runs entirely off the dataset files, so it needs no API keys and no
 * database: it answers "of the AniList ids a discover slider would hand us,
 * how many does a dataset map straight to TMDB". Coverage of what an instance
 * actually served is on the Mapping settings page instead.
 *
 * Usage: bun run measure:mapping
 */
import { DATASETS } from '@server/lib/mapping/definitions';
import type { EdgeRow } from '@server/lib/mapping/parsers';
import axios from 'axios';

const percent = (part: number, whole: number): string =>
  whole === 0 ? 'n/a' : `${((part / whole) * 100).toFixed(1)}%`;

async function load(urls: string[]): Promise<string> {
  const failures: string[] = [];
  for (const url of urls) {
    try {
      const { data } = await axios.get<string>(url, {
        timeout: 120_000,
        responseType: 'text',
        transformResponse: (body) => body,
      });
      return data;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(failures.join('; '));
}

const isTmdb = (edge: EdgeRow): boolean =>
  edge.dstNs === 'tmdb_show' || edge.dstNs === 'tmdb_movie';

async function main(): Promise<void> {
  const reached = new Set<string>();
  const known = new Set<string>();

  for (const dataset of [...DATASETS].sort((a, b) => a.rank - b.rank)) {
    let edges: EdgeRow[];
    let version: string | undefined;
    try {
      ({ edges, version } = dataset.parse(await load(dataset.urls)));
    } catch (error) {
      // eslint-disable-next-line no-console
      console.log(
        `${dataset.key.padEnd(10)} unavailable (${error instanceof Error ? error.message : String(error)})`
      );
      continue;
    }

    const anilist = new Set<string>();
    const toTmdb = new Set<string>();
    let ranged = 0;
    for (const edge of edges) {
      if (edge.srcRange) ranged += 1;
      if (edge.srcNs !== 'anilist') continue;
      anilist.add(edge.srcId);
      if (isTmdb(edge)) toTmdb.add(edge.srcId);
    }
    // A later dataset only answers where an earlier one has no TMDB edge.
    const filled = [...toTmdb].filter((id) => !reached.has(id)).length;
    for (const id of anilist) known.add(id);
    for (const id of toTmdb) reached.add(id);

    // eslint-disable-next-line no-console
    console.log(
      [
        dataset.key.padEnd(10),
        `${edges.length} edges`.padEnd(15),
        `ranged ${ranged}`.padEnd(15),
        `anilist ${anilist.size}`.padEnd(15),
        `→tmdb ${percent(toTmdb.size, anilist.size)}`.padEnd(13),
        `adds ${filled}`.padEnd(12),
        version ?? '',
      ].join(' ')
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    `\ncombined: ${known.size} anilist ids, ${percent(reached.size, known.size)} map straight to TMDB`
  );
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
