/**
 * Persistent local Jellyfin with the Foreseerr plugin for manual testing.
 *
 *   bun run plugin:dev up [12|10.11] [--build] [--base /jellyfin] [--port 8096]
 *   bun run plugin:dev down|logs|reset [12|10.11]
 *
 * `up` reinstalls the current plugin build on every run, so the loop is:
 * edit, `bun run plugin:dev up 12 --build`, reload the browser.
 */
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { arch } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const TARGETS = {
  12: {
    image: 'jellyfin/jellyfin:12.1',
    port: 8096,
    fileTransformation: 'Release-12.1.0.zip',
  },
  10.11: {
    image: 'jellyfin/jellyfin:10.11.11',
    port: 8097,
    fileTransformation: 'Release-10.11.11.zip',
  },
};
const FILE_TRANSFORMATION_RELEASE =
  'https://github.com/IAmParadox27/jellyfin-plugin-file-transformation/releases/download/3.0.1.0/';
const ADMIN = { name: 'admin', password: 'foreseerr' };
const VIEWER = { name: 'viewer', password: 'viewer' };

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    build: { type: 'boolean', default: false },
    base: { type: 'string' },
    port: { type: 'string' },
    bind: { type: 'string', default: '127.0.0.1' },
    image: { type: 'string' },
    'no-file-transformation': { type: 'boolean', default: false },
  },
});
const [command = 'up', abi = '12'] = positionals;
const target = TARGETS[abi];
if (!target || !['up', 'down', 'logs', 'reset'].includes(command)) {
  console.error(
    'usage: bun run plugin:dev <up|down|logs|reset> [12|10.11] [--build] [--base /jellyfin] [--port N] [--bind 0.0.0.0] [--image jellyfin/jellyfin:TAG] [--no-file-transformation]'
  );
  process.exit(1);
}

const root = resolve(import.meta.dir, '..');
const devRoot = join(root, 'plugin/.dev');
const home = join(devRoot, `jellyfin-${abi}`);
const stateFile = join(home, 'env.json');
const container = `foreseerr-jellyfin-dev-${abi.replace('.', '')}`;

async function run(args, { quiet = true } = {}) {
  const child = Bun.spawn(args, {
    cwd: root,
    stdout: quiet ? 'pipe' : 'inherit',
    stderr: quiet ? 'pipe' : 'inherit',
  });
  const [out, error, code] = await Promise.all([
    quiet ? new Response(child.stdout).text() : '',
    quiet ? new Response(child.stderr).text() : '',
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${args.join(' ')} failed: ${error.trim()}`);
  return out.trim();
}

const exists = (path) =>
  stat(path).then(
    () => true,
    () => false
  );

async function removeContainer() {
  await run(['docker', 'rm', '-f', container]).catch(() => {});
}

if (command === 'logs') {
  await run(['docker', 'logs', '-f', '--tail', '200', container], {
    quiet: false,
  });
  process.exit(0);
}
if (command === 'down') {
  await removeContainer();
  console.log(`Stopped ${container}. Data kept in ${home}`);
  process.exit(0);
}
if (command === 'reset') {
  await removeContainer();
  await rm(home, { recursive: true, force: true });
  console.log(`Removed ${container} and ${home}`);
  process.exit(0);
}

// --- up ---------------------------------------------------------------------

const state = (await exists(stateFile))
  ? JSON.parse(await readFile(stateFile, 'utf8'))
  : null;
const base = (options.base ?? state?.base ?? '').replace(/\/$/, '');
if (base && !/^\/[A-Za-z0-9._~/-]+$/.test(base)) {
  throw new Error(`Invalid --base ${base}`);
}
if (state && options.base !== undefined && base !== state.base) {
  throw new Error(
    `This environment was set up with base "${state.base}". Run "bun run plugin:dev reset ${abi}" to change it.`
  );
}
const port = Number(options.port ?? state?.port ?? target.port);
const image = options.image ?? state?.image ?? target.image;
const origin = `http://127.0.0.1:${port}`;

// Build the plugin for this machine's architecture when asked or missing.
const sidecar = arch() === 'arm64' ? 'linux-arm64' : 'linux-x64';
const pluginBuild = join(root, `plugin/dist/jellyfin-${abi}/Foreseerr`);
if (
  options.build ||
  !(await exists(join(pluginBuild, `sidecar/foreseerr-${sidecar}`)))
) {
  console.log(
    `Building Foreseerr sidecar (${sidecar}) and plugin for Jellyfin ${abi}...`
  );
  await run(['bun', 'run', 'compile:plugin', '--', `bun-${sidecar}`], {
    quiet: false,
  });
  await run(['plugin/build.sh', abi, sidecar], { quiet: false });
}

async function call(
  path,
  { token, body, method, headers = {}, ok = [200, 204] } = {}
) {
  const response = await fetch(origin + path, {
    method: method || (body !== undefined ? 'POST' : 'GET'),
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `MediaBrowser Token="${token}"` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!ok.includes(response.status)) {
    throw new Error(
      `${path}: HTTP ${response.status} ${await response.text()}`
    );
  }
  return response;
}

async function waitFor(label, action, seconds = 180) {
  const deadline = Date.now() + seconds * 1000;
  let last;
  while (Date.now() < deadline) {
    try {
      return await action();
    } catch (error) {
      last = error;
    }
    await Bun.sleep(1000);
  }
  throw new Error(`Timed out waiting for ${label}: ${last?.message}`);
}

async function login(prefix, user) {
  const response = await call(prefix + '/Users/AuthenticateByName', {
    body: { Username: user.name, Pw: user.password },
    headers: {
      Authorization: `MediaBrowser Client="Foreseerr dev", Device="plugin:dev", DeviceId="${randomUUID()}", Version="1.0"`,
    },
  });
  return (await response.json()).AccessToken;
}

async function startContainer() {
  await removeContainer();
  await run([
    'docker',
    'run',
    '-d',
    '--name',
    container,
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '-p',
    `${options.bind}:${port}:8096`,
    '-v',
    `${join(home, 'config')}:/config`,
    '-v',
    `${join(home, 'cache')}:/cache`,
    '-v',
    `${join(home, 'media')}:/media`,
    image,
  ]);
}

await mkdir(join(home, 'cache'), { recursive: true });
await mkdir(join(home, 'config/plugins'), { recursive: true });
await mkdir(join(home, 'media/movies'), { recursive: true });
await mkdir(join(home, 'media/shows'), { recursive: true });

async function firstRunSetup() {
  console.log(
    `First run: setting up ${image} (the image is large on first pull)...`
  );
  await startContainer();
  await waitFor('Jellyfin', () => call('/Startup/Configuration'));
  await call('/Startup/Configuration', {
    body: {
      UICulture: 'en-US',
      MetadataCountryCode: 'US',
      PreferredMetadataLanguage: 'en',
    },
  });
  await call('/Startup/User');
  await call('/Startup/User', {
    body: { Name: ADMIN.name, Password: ADMIN.password },
  });
  await call('/Startup/RemoteAccess', {
    body: { EnableRemoteAccess: true, EnableAutomaticPortMapping: false },
  });
  await call('/Startup/Complete', { method: 'POST' });
  const token = await login('', ADMIN);
  for (const [name, collectionType, path] of [
    ['Movies', 'movies', '/media/movies'],
    ['Shows', 'tvshows', '/media/shows'],
  ]) {
    await call(
      `/Library/VirtualFolders?name=${name}&collectionType=${collectionType}&paths=${encodeURIComponent(path)}&refreshLibrary=false`,
      { token, body: { LibraryOptions: {} } }
    );
  }
  await call('/Users/New', {
    token,
    body: { Name: VIEWER.name, Password: VIEWER.password },
  });
  if (base) {
    const network = await (
      await call('/System/Configuration/network', { token })
    ).json();
    await call('/System/Configuration/network', {
      token,
      body: { ...network, BaseUrl: base },
    });
  }
  await removeContainer();
}

const writeState = () =>
  writeFile(stateFile, JSON.stringify({ base, port, image }, null, 2) + '\n');

if (!state) {
  try {
    await firstRunSetup();
    await writeState();
  } catch (error) {
    await removeContainer();
    await rm(join(home, 'config'), { recursive: true, force: true });
    throw new Error(
      `First-run setup failed and was rolled back: ${error.message}`
    );
  }
}

// Install the current plugin build (and File Transformation for the header button).
const plugins = join(home, 'config/plugins');
await rm(join(plugins, 'Foreseerr'), { recursive: true, force: true });
await cp(pluginBuild, join(plugins, 'Foreseerr'), { recursive: true });
const fileTransformation = join(plugins, 'FileTransformation');
if (options['no-file-transformation']) {
  await rm(fileTransformation, { recursive: true, force: true });
} else if (!(await exists(fileTransformation))) {
  const archive = join(devRoot, 'downloads', target.fileTransformation);
  if (!(await exists(archive))) {
    await mkdir(join(devRoot, 'downloads'), { recursive: true });
    const response = await fetch(
      FILE_TRANSFORMATION_RELEASE + target.fileTransformation
    );
    if (!response.ok)
      throw new Error(
        `File Transformation download failed: HTTP ${response.status}`
      );
    await Bun.write(archive, response);
  }
  await mkdir(fileTransformation, { recursive: true });
  await run(['unzip', '-q', '-o', archive, '-d', fileTransformation]);
}

await startContainer();
// Jellyfin 12 answers from a temporary setup server while it migrates, then
// resets those connections; retry sign-in until the real server is up.
const token = await waitFor('Jellyfin sign-in', () => login(base, ADMIN));
const status = await waitFor('the Foreseerr sidecar', async () => {
  const status = await (
    await call(base + '/ForeseerrPlugin/Status', { token })
  ).json();
  if (!status.ready) throw new Error(status.lastError || 'still starting');
  return status;
});
const meta = JSON.parse(await readFile(join(pluginBuild, 'meta.json'), 'utf8'));
await writeState();

console.log(`
Jellyfin (${image}) with Foreseerr plugin ${meta.version} is running.

  Jellyfin web   ${origin}${base}/web/
  Admin          ${ADMIN.name} / ${ADMIN.password}
  Non-admin      ${VIEWER.name} / ${VIEWER.password}
  Open Foreseerr header "F" button${options['no-file-transformation'] ? ' (disabled: --no-file-transformation)' : ''}, or Dashboard > Plugins > Foreseerr > Open Foreseerr
  Sidecar        pid ${status.pid}, loopback port ${status.sidecarPort}
  Media folders  ${join(home, 'media')}/{movies,shows}

  Reinstall after changes   bun run plugin:dev up ${abi} --build
  Jellyfin + sidecar logs   bun run plugin:dev logs ${abi}
  Stop / wipe               bun run plugin:dev down ${abi} | reset ${abi}
`);
if (options.bind !== '127.0.0.1') {
  console.warn(
    `Warning: bound to ${options.bind} with development passwords. Use only on a trusted network.`
  );
}
