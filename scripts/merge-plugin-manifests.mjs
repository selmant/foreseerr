import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../plugin/dist');
const output = join(root, 'release');
await mkdir(output, { recursive: true });
const versions = [];
let entry;
let sums = '';
for (const abi of ['12', '10.11']) {
  const directory = join(root, `jellyfin-${abi}`);
  const manifest = JSON.parse(
    await readFile(join(directory, 'manifest.json'), 'utf8')
  )[0];
  if (entry && entry.guid !== manifest.guid)
    throw new Error('Plugin GUIDs differ');
  entry = manifest;
  versions.push(...manifest.versions);
  sums += await readFile(join(directory, 'SHA256SUMS'), 'utf8');
  await copyFile(
    join(directory, `foreseerr-jellyfin-${abi}.zip`),
    join(output, `foreseerr-jellyfin-${abi}.zip`)
  );
}
// Jellyfin picks the highest compatible version; a tie would let a newer
// server install the older ABI build.
if (
  new Set(versions.map((version) => version.version)).size !== versions.length
)
  throw new Error('Each Jellyfin ABI build needs a distinct plugin version');
await writeFile(
  join(output, 'foreseerr-jellyfin-manifest.json'),
  JSON.stringify([{ ...entry, versions }], null, 2) + '\n'
);
await writeFile(join(output, 'SHA256SUMS'), sums);
console.log(`Release assets: ${output}`);
