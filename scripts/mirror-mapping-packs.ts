/**
 * Mirror every mapping dataset to a homelab bucket.
 *
 * Upstream datasets live on GitHub and jsDelivr; both have gone away mid-day
 * before, and a dataset that cannot be fetched leaves anime mapping stale
 * until the next refresh. Running this daily gives each one a mirror that is
 * under our control, reachable through `MAPPING_MIRROR_TEMPLATES`.
 *
 * Usage:
 *   MAPPING_MIRROR_DIR=/srv/packs bun run mirror:packs
 *   MAPPING_MIRROR_S3=s3://garage/foreseerr-packs bun run mirror:packs
 *
 * The S3 form shells out to the `aws` CLI, which the homelab runner already
 * has configured against Garage; no SDK dependency is added for a cron script.
 */
import {
  DATASETS,
  type DatasetDefinition,
} from '@server/lib/mapping/definitions';
import axios from 'axios';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const MIRROR_DIR = process.env.MAPPING_MIRROR_DIR;
const MIRROR_S3 = process.env.MAPPING_MIRROR_S3;
const TIMEOUT_MSEC = 120_000;

async function download(dataset: DatasetDefinition): Promise<string> {
  const failures: string[] = [];
  for (const url of dataset.urls) {
    try {
      const { data } = await axios.get<string>(url, {
        timeout: TIMEOUT_MSEC,
        responseType: 'text',
        transformResponse: (body) => body,
      });
      // Mirroring a truncated body would turn our fallback into the problem it
      // exists to solve.
      if (!dataset.parse(data).edges.length) {
        throw new Error('dataset parsed to zero edges');
      }
      return data;
    } catch (error) {
      failures.push(
        `${url}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  throw new Error(`every mirror failed\n  ${failures.join('\n  ')}`);
}

async function publish(name: string, body: string): Promise<void> {
  if (MIRROR_DIR) {
    await fsp.mkdir(MIRROR_DIR, { recursive: true });
    const target = path.join(MIRROR_DIR, name);
    const temporary = `${target}.tmp`;
    await fsp.writeFile(temporary, body, 'utf8');
    await fsp.rename(temporary, target);
  }

  if (MIRROR_S3) {
    const staging = path.join(
      await fsp.mkdtemp(path.join(os.tmpdir(), 'pack-mirror-')),
      name
    );
    await fsp.writeFile(staging, body, 'utf8');
    await run('aws', [
      's3',
      'cp',
      staging,
      `${MIRROR_S3.replace(/\/$/, '')}/${name}`,
      '--acl',
      'public-read',
    ]);
    await fsp.rm(path.dirname(staging), { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (!MIRROR_DIR && !MIRROR_S3) {
    throw new Error(
      'Set MAPPING_MIRROR_DIR and/or MAPPING_MIRROR_S3 to choose a destination.'
    );
  }

  let failed = 0;

  for (const dataset of DATASETS) {
    const name = `${dataset.key}.json`;
    try {
      const body = await download(dataset);
      await publish(name, body);
      const digest = createHash('sha256').update(body).digest('hex');
      // eslint-disable-next-line no-console
      console.log(
        `mirrored ${name} (${body.length} bytes, sha256 ${digest.slice(0, 12)})`
      );
    } catch (error) {
      failed += 1;
      // eslint-disable-next-line no-console
      console.error(
        `failed ${name}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // A partial mirror is still useful, so only a total failure is fatal.
  if (failed === DATASETS.length) process.exitCode = 1;
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
