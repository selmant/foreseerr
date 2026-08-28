/**
 * Mirror every mapping pack in the manifest to a homelab bucket.
 *
 * Upstream packs live on GitHub raw and jsDelivr; both have gone away mid-day
 * before, and a pack that cannot be fetched degrades anime mapping until the
 * next refresh. Running this daily gives every pack a third mirror that is
 * under our control.
 *
 * Usage:
 *   MAPPING_MIRROR_DIR=/srv/packs ts-node scripts/mirror-mapping-packs.ts
 *   MAPPING_MIRROR_S3=s3://garage/foreseerr-packs ts-node scripts/mirror-mapping-packs.ts
 *
 * The S3 form shells out to the `aws` CLI, which the homelab runner already
 * has configured against Garage; no SDK dependency is added for a cron script.
 */
import { validatePackBody } from '@server/lib/mapping/packs/formats';
import {
  fetchManifest,
  type PackManifestEntry,
} from '@server/lib/mapping/packs/manifest';
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

const extensionFor = (pack: PackManifestEntry): string => {
  if (pack.format === 'xml-animelist') return 'xml';
  if (pack.format === 'yaml-map') return 'yaml';
  if (pack.format === 'ndjson') return 'ndjson';
  return 'json';
};

async function download(pack: PackManifestEntry): Promise<string> {
  const failures: string[] = [];
  for (const url of pack.mirrors) {
    try {
      const { data } = await axios.get<string>(url, {
        timeout: TIMEOUT_MSEC,
        responseType: 'text',
        transformResponse: (body) => body,
      });
      // Mirroring a truncated body would turn our fallback into the problem it
      // exists to solve.
      validatePackBody(pack.format, data);
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

  const manifest = await fetchManifest();
  let failed = 0;

  for (const pack of manifest.packs) {
    const name = `${pack.key}.${extensionFor(pack)}`;
    try {
      const body = await download(pack);
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
  if (failed === manifest.packs.length) process.exitCode = 1;
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
