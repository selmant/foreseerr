/**
 * Pack bun run build output for GitHub Releases (launcher.js server, not --compile).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const OUT_DIR = join(REPO_ROOT, 'dist/bin');
const ARCHIVE = 'foreseerr-server.tar.gz';

const MEMBERS = ['dist', 'package.json', 'bun.lock', 'seerr-api.yml'];

if (import.meta.main) {
  const launcher = join(REPO_ROOT, 'dist/launcher.js');
  if (!existsSync(launcher)) {
    throw new Error('missing dist/launcher.js; run bun run build first');
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const archivePath = join(OUT_DIR, ARCHIVE);
  const proc = Bun.spawn(
    [
      'tar',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '--exclude=dist/bin',
      '-czf',
      archivePath,
      ...MEMBERS,
    ],
    {
      cwd: REPO_ROOT,
      stdout: 'inherit',
      stderr: 'inherit',
    }
  );
  if ((await proc.exited) !== 0) {
    throw new Error(`tar ${ARCHIVE} failed`);
  }
  const digest = createHash('sha256')
    .update(readFileSync(archivePath))
    .digest('hex');
  const sumsPath = join(OUT_DIR, 'SHA256SUMS');
  const line = `${digest}  ${ARCHIVE}\n`;
  if (existsSync(sumsPath)) {
    writeFileSync(sumsPath, `${readFileSync(sumsPath, 'utf8').trimEnd()}\n${line}`);
  } else {
    writeFileSync(sumsPath, line);
  }
  console.log(`${ARCHIVE} ${Bun.file(archivePath).size} bytes sha256=${digest}`);
}
