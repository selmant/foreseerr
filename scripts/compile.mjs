/**
 * Cross-compile Foreseerr to linux x64/arm64 and windows-x64 binaries.
 */
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const OUT_DIR = join(REPO_ROOT, 'dist/bin');

const TARGETS = [
  {
    target: 'bun-linux-x64',
    outfile: join(OUT_DIR, 'foreseerr-linux-x64'),
  },
  {
    target: 'bun-linux-arm64',
    outfile: join(OUT_DIR, 'foreseerr-linux-arm64'),
  },
  {
    target: 'bun-windows-x64',
    outfile: join(OUT_DIR, 'foreseerr-windows-x64.exe'),
  },
];

async function ensureWebBuild() {
  if (!existsSync(join(REPO_ROOT, 'dist/public/index.html'))) {
    const proc = Bun.spawn(['bun', 'run', 'build:web'], {
      cwd: REPO_ROOT,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`build:web failed with ${code}`);
    }
  }
}

async function generateRegistry() {
  const proc = Bun.spawn(['bun', 'scripts/generate-compile-registry.mjs'], {
    cwd: REPO_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`generate-compile-registry failed with ${code}`);
  }
}

async function compileTarget({ target, outfile }) {
  const args = [
    'build',
    '--compile',
    '--keep-names',
    '--target',
    target,
    '--define',
    'process.env.NODE_ENV="production"',
    '--outfile',
    outfile,
    '--asset',
    'seerr-api.yml',
    '--asset',
    'dist/public',
    '--asset',
    'server/i18n/locale',
    '--asset',
    'server/templates',
    'server/standalone.ts',
  ];
  console.log(`compiling ${target} -> ${outfile}`);
  const proc = Bun.spawn(['bun', ...args], {
    cwd: REPO_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`compile ${target} failed with ${code}`);
  }
}

if (import.meta.main) {
  mkdirSync(OUT_DIR, { recursive: true });
  await generateRegistry();
  await ensureWebBuild();
  const requested = Bun.argv.slice(2);
  const selected =
    requested.length === 0
      ? TARGETS
      : TARGETS.filter(
          (entry) =>
            requested.includes(entry.target) ||
            requested.includes(entry.outfile) ||
            requested.some((arg) => entry.outfile.endsWith(arg))
        );
  if (selected.length === 0) {
    throw new Error(
      `unknown compile target(s): ${requested.join(', ')} (expected ${TARGETS.map((entry) => entry.target).join(', ')})`
    );
  }
  for (const target of selected) {
    await compileTarget(target);
  }
  console.log('compiled binaries in dist/bin');
}
