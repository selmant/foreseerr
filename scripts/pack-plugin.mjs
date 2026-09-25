import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Usage: pack-plugin.mjs <abi> <publish dir> <msbuild -getProperty JSON>
const [abi, output, properties] = process.argv.slice(2);
if (!['10.11', '12'].includes(abi) || !output || !properties) {
  throw new Error('Expected ABI, publish directory, and MSBuild properties');
}
const { AssemblyVersion: version, TargetAbi: targetAbi } =
  JSON.parse(properties).Properties;
if (
  !/^\d+\.\d+\.\d+\.\d+$/.test(version) ||
  !/^\d+\.\d+\.\d+\.\d+$/.test(targetAbi)
) {
  throw new Error(
    `Invalid plugin version ${version} or targetAbi ${targetAbi}`
  );
}
const root = resolve(import.meta.dir, '..');
// Release assets live under the tag, which keeps any prerelease suffix.
const release = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8')
).version;
const template = JSON.parse(
  readFileSync(join(root, 'plugin/manifest.template.json'), 'utf8')
)[0];
const dlls = readdirSync(output).filter((name) => name.endsWith('.dll'));
if (dlls.length !== 1 || dlls[0] !== 'Foreseerr.Jellyfin.dll') {
  throw new Error(`Unexpected bundled host assemblies: ${dlls}`);
}
const timestamp = new Date(
  Number(process.env.SOURCE_DATE_EPOCH || Date.now() / 1000) * 1000
).toISOString();
const meta = {
  ...template,
  version,
  targetAbi,
  timestamp,
  status: 'Active',
  autoUpdate: true,
  assemblies: ['Foreseerr.Jellyfin.dll'],
};
delete meta.versions;
writeFileSync(join(output, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
const archive = join(dirname(output), `foreseerr-jellyfin-${abi}.zip`);
// Recreate the archive so removed files cannot survive an incremental build.
await Bun.file(archive)
  .delete()
  .catch(() => {});
const zip = Bun.spawn(['zip', '-qr', archive, '.'], {
  cwd: output,
  stdout: 'inherit',
  stderr: 'inherit',
});
if ((await zip.exited) !== 0)
  throw new Error('Could not create plugin archive');
const bytes = readFileSync(archive);
const manifest = [
  {
    ...template,
    versions: [
      {
        version,
        targetAbi,
        timestamp,
        changelog: `Foreseerr ${release} for Jellyfin ${abi}`,
        sourceUrl: `https://github.com/selmant/foreseerr/releases/download/v${release}/foreseerr-jellyfin-${abi}.zip`,
        // Jellyfin's repository format requires MD5. SHA-256 is supplied alongside it.
        checksum: createHash('md5').update(bytes).digest('hex'),
      },
    ],
  },
];
writeFileSync(
  join(dirname(output), 'manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n'
);
writeFileSync(
  join(dirname(output), 'SHA256SUMS'),
  `${createHash('sha256').update(bytes).digest('hex')}  foreseerr-jellyfin-${abi}.zip\n`
);
console.log(`Packed ${archive} (${version}, targetAbi ${targetAbi})`);
