/**
 * Pack compiled binaries for GitHub Releases: tar.gz on Linux, zip on Windows.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const OUT_DIR = join(REPO_ROOT, 'dist/bin');

const ARCHIVES = [
  {
    source: 'foreseerr-linux-x64',
    archive: 'foreseerr-linux-x64.tar.gz',
    kind: 'tar',
  },
  {
    source: 'foreseerr-linux-arm64',
    archive: 'foreseerr-linux-arm64.tar.gz',
    kind: 'tar',
  },
  {
    source: 'foreseerr-windows-x64.exe',
    archive: 'foreseerr-windows-x64.zip',
    kind: 'zip',
  },
];

async function run(cmd, args) {
  const proc = Bun.spawn([cmd, ...args], {
    cwd: OUT_DIR,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed with ${code}`);
  }
}

async function packTar(source, archive) {
  await run('tar', [
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '-czf',
    archive,
    source,
  ]);
}

async function packZip(source, archive) {
  try {
    const zipProc = Bun.spawn(['zip', '-9', '-X', archive, source], {
      cwd: OUT_DIR,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if ((await zipProc.exited) === 0) {
      return;
    }
  } catch {
    // zip(1) is optional; Python's zipfile is on Ubuntu runners and most desktops.
  }
  await run('python3', [
    '-c',
    [
      'import zipfile, sys',
      'source, archive = sys.argv[1], sys.argv[2]',
      'with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:',
      '    z.write(source, source)',
    ].join('\n'),
    source,
    archive,
  ]);
}

if (import.meta.main) {
  const hashes = [];
  for (const entry of ARCHIVES) {
    const sourcePath = join(OUT_DIR, entry.source);
    if (!existsSync(sourcePath)) {
      throw new Error(`missing ${sourcePath}; run bun run compile first`);
    }
    const archivePath = join(OUT_DIR, entry.archive);
    if (entry.kind === 'tar') {
      await packTar(entry.source, entry.archive);
    } else {
      await packZip(entry.source, entry.archive);
    }
    const digest = createHash('sha256')
      .update(readFileSync(archivePath))
      .digest('hex');
    hashes.push(`${digest}  ${entry.archive}`);
    console.log(
      `${entry.archive} ${Bun.file(archivePath).size} bytes sha256=${digest}`
    );
  }
  writeFileSync(join(OUT_DIR, 'SHA256SUMS'), `${hashes.join('\n')}\n`);
  console.log('wrote dist/bin/SHA256SUMS');
}
