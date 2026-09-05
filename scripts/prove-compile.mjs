/**
 * Boot the linux-x64 compiled binary: SQLite migrate, SPA, /api/v1/status.
 */
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const BINARY = join(REPO_ROOT, 'dist/bin/foreseerr-linux-x64');
const PORT = Number(process.env.FORESEERR_COMPILE_PROVE_PORT ?? '18055');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReady(url, timeoutMs = 30_000) {
  const started = Date.now();
  let lastError = 'not started';
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 401) {
        return response;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${url}: ${lastError}`);
}

if (import.meta.main) {
  if (!existsSync(BINARY)) {
    const compile = Bun.spawn(['bun', 'scripts/compile.mjs', 'bun-linux-x64'], {
      cwd: REPO_ROOT,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const code = await compile.exited;
    if (code !== 0) {
      process.exit(code);
    }
  }

  const workdir = mkdtempSync(join(tmpdir(), 'foreseerr-compile-prove-'));
  const configDirectory = join(workdir, 'config');
  const origin = `http://127.0.0.1:${PORT}`;
  const proc = Bun.spawn([BINARY], {
    cwd: workdir,
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      CONFIG_DIRECTORY: configDirectory,
      HOST: '127.0.0.1',
      PORT: String(PORT),
    },
  });

  try {
    const statusResponse = await waitForReady(`${origin}/api/v1/status`);
    const status = await statusResponse.json();
    if (typeof status.version !== 'string' || status.version.length === 0) {
      throw new Error(
        `unexpected /api/v1/status body: ${JSON.stringify(status)}`
      );
    }

    const spaResponse = await fetch(`${origin}/`);
    const spa = await spaResponse.text();
    if (!spaResponse.ok || !spa.includes('<div id="root"')) {
      throw new Error(
        `SPA was not served (${spaResponse.status}): ${spa.slice(0, 200)}`
      );
    }
    const assetMatch = spa.match(/src="(\/assets\/[^"]+\.js)"/);
    if (assetMatch) {
      const assetResponse = await fetch(`${origin}${assetMatch[1]}`);
      if (!assetResponse.ok) {
        throw new Error(
          `SPA asset ${assetMatch[1]} returned ${assetResponse.status}`
        );
      }
    }

    const sqlitePath = join(configDirectory, 'db/db.sqlite3');
    if (!existsSync(sqlitePath)) {
      throw new Error(`SQLite database missing at ${sqlitePath}`);
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          version: status.version,
          sqlite: sqlitePath,
          spaBytes: spa.length,
        },
        null,
        2
      )
    );
  } finally {
    proc.kill();
    await proc.exited;
  }
}
