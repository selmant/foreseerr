/** Install a built plugin in a disposable Jellyfin container and exercise real SSO. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const abi = process.argv[2] || '10.11';
const image =
  process.env.JELLYFIN_TEST_IMAGE ||
  (abi === '12' ? 'jellyfin/jellyfin:12.1' : 'jellyfin/jellyfin:10.11.11');
const base = process.env.JELLYFIN_TEST_BASE || '/jellyfin';
const root = resolve(import.meta.dir, '..');
const fixture = await mkdtemp(join(tmpdir(), 'foreseerr-jellyfin-proof-'));
const name = `foreseerr-plugin-proof-${process.pid}`;
let origin;
async function command(args) {
  const process = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  const [out, error, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code !== 0)
    throw new Error(`${args.slice(0, 3).join(' ')} failed: ${error}`);
  return out.trim();
}
async function call(
  path,
  { token, cookie, body, method, headers = {}, expected = 200 } = {}
) {
  const response = await fetch(origin + path, {
    method: method || (body !== undefined ? 'POST' : 'GET'),
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `MediaBrowser Token="${token}"` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(
    response.status,
    expected,
    `${path}: ${await response.clone().text()}`
  );
  return response;
}
async function waitFor(action, seconds = 90) {
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
  throw last;
}
const password = randomUUID();
async function login(username = 'plugin-admin', device = randomUUID()) {
  const response = await call(base + '/Users/AuthenticateByName', {
    body: { Username: username, Pw: password },
    headers: {
      Authorization: `MediaBrowser Client="Foreseerr proof", Device="Test", DeviceId="${device}", Version="1.0"`,
    },
  });
  return (await response.json()).AccessToken;
}
async function sso(token, priorCookie) {
  const response = await call(base + '/Foreseerr/sso', {
    token,
    cookie: priorCookie,
    method: 'POST',
  });
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 1);
  assert.match(cookies[0], /HttpOnly/i);
  assert.match(cookies[0], /SameSite=Strict/i);
  assert.ok(cookies[0].includes(`path=${base}/Foreseerr`));
  assert.ok(!cookies[0].includes(token));
  assert.equal((await response.json()).url, base + '/Foreseerr/');
  return cookies[0].split(';', 1)[0];
}
try {
  await mkdir(join(fixture, 'cache'), { recursive: true });
  await mkdir(join(fixture, 'plugins'), { recursive: true });
  await mkdir(join(fixture, 'test-media/movies'), { recursive: true });
  await command([
    'docker',
    'run',
    '-d',
    '--name',
    name,
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '-p',
    '127.0.0.1::8096',
    '-v',
    `${fixture}:/config`,
    '-v',
    `${fixture}/cache:/cache`,
    image,
  ]);
  origin = 'http://' + (await command(['docker', 'port', name, '8096/tcp']));
  console.log('Waiting for Jellyfin at', origin);
  await waitFor(() => call('/Startup/Configuration'));
  console.log('Configuring Jellyfin');
  await call('/Startup/Configuration', {
    body: {
      UICulture: 'en-US',
      MetadataCountryCode: 'US',
      PreferredMetadataLanguage: 'en',
    },
    expected: 204,
  });
  await call('/Startup/User');
  await call('/Startup/User', {
    body: { Name: 'plugin-admin', Password: password },
    expected: 204,
  });
  await call('/Startup/RemoteAccess', {
    body: { EnableRemoteAccess: true, EnableAutomaticPortMapping: false },
    expected: 204,
  });
  await call('/Startup/Complete', { method: 'POST', expected: 204 });
  // Configure the host before installing the plugin, as on an existing server.
  const initial = await call('/Users/AuthenticateByName', {
    body: { Username: 'plugin-admin', Pw: password },
    headers: {
      Authorization:
        'MediaBrowser Client="Foreseerr proof", Device="Test", DeviceId="setup", Version="1.0"',
    },
  });
  const initialToken = (await initial.json()).AccessToken;
  const network = await (
    await call('/System/Configuration/network', { token: initialToken })
  ).json();
  await call('/System/Configuration/network', {
    token: initialToken,
    body: { ...network, BaseUrl: base },
    expected: 204,
  });
  await command(['docker', 'stop', '-t', '10', name]);
  await cp(
    join(root, `plugin/dist/jellyfin-${abi}/Foreseerr`),
    join(fixture, 'plugins/Foreseerr'),
    { recursive: true }
  );
  if (process.env.FORESEERR_TEST_FT_ARCHIVE) {
    await mkdir(join(fixture, 'plugins/FileTransformation'), {
      recursive: true,
    });
    await command([
      'unzip',
      '-q',
      process.env.FORESEERR_TEST_FT_ARCHIVE,
      '-d',
      join(fixture, 'plugins/FileTransformation'),
    ]);
  }
  await command(['docker', 'start', name]);
  // Docker may assign a new ephemeral host port on restart.
  origin = 'http://' + (await command(['docker', 'port', name, '8096/tcp']));
  await waitFor(() => call(base + '/System/Info/Public'));
  console.log('Plugin installed; waiting for readiness');
  // Jellyfin 12 answers from a temporary setup server while it migrates, then
  // resets those connections; retry sign-in until the real server is up.
  const token = await waitFor(() => login());
  const statusPath = base + '/ForeseerrPlugin/Status';
  const status = await waitFor(async () => {
    const status = await (await call(statusPath, { token })).json();
    assert.equal(status.ready, true, status.lastError || 'Sidecar is starting');
    return status;
  });
  assert.ok(status.sidecarPort > 0);
  // No public URL yet: notifications have no links.
  assert.equal(status.publicUrl, '');
  assert.equal(status.headerButton, !!process.env.FORESEERR_TEST_FT_ARCHIVE);
  if (process.env.FORESEERR_TEST_FT_ARCHIVE) {
    const jellyfinWeb = await (await call(base + '/web/index.html')).text();
    assert.ok(jellyfinWeb.includes('../ForeseerrPlugin/loader.js'));
    await call(base + '/ForeseerrPlugin/loader.js');
  }
  await call(base + '/Foreseerr/', { expected: 401 });
  // Links from notifications and bookmarks get a page that signs in with the
  // browser's Jellyfin login and reloads the requested path.
  const signIn = await call(base + '/Foreseerr/movie/603', {
    headers: { Accept: 'text/html' },
    expected: 401,
  });
  const signInPage = await signIn.text();
  const serverId = (await (await call(base + '/System/Info/Public')).json()).Id;
  assert.ok(signInPage.includes(`data-server-id="${serverId}"`));
  assert.ok(signInPage.includes(`data-sso="${base}/Foreseerr/sso"`));
  assert.match(
    signIn.headers.get('content-security-policy'),
    /script-src 'nonce-/
  );
  assert.equal(signIn.headers.getSetCookie().length, 0);
  // Signing in again from the same Jellyfin login rotates its one ticket.
  const replaced = await sso(token);
  let cookie = await sso(token);
  await call(base + '/Foreseerr/api/v1/auth/me', {
    cookie: replaced,
    expected: 401,
  });
  const me = await (
    await call(base + '/Foreseerr/api/v1/auth/me', { cookie })
  ).json();
  assert.equal(me.jellyfinUsername, 'plugin-admin');
  // The avatar proxy only accepts Jellyfin's compact user id.
  assert.match(me.avatar, /^\/avatarproxy\/[0-9a-f]{32}(\?|$)/);
  // The OpenAPI validator must match mounted routes: it rejects bad input
  // and makes Express 5 req.query writable for the Discover defaults.
  await call(base + '/Foreseerr/api/v1/discover/watchlist', { cookie });
  await call(base + '/Foreseerr/api/v1/discover/movies?page=abc', {
    cookie,
    expected: 400,
  });
  const html = await (
    await call(base + '/Foreseerr/discover', { cookie })
  ).text();
  assert.ok(html.includes(`<base href="${base}/Foreseerr/">`));
  const entry = html.match(/src="([^\"]+\.js)"/)[1];
  const asset = new URL(entry, origin + base + '/Foreseerr/');
  await call(asset.pathname, { cookie });
  await call(base + '/Foreseerr/api/v1/request', {
    cookie,
    body: {},
    headers: { Origin: 'https://evil.test' },
    expected: 403,
  });
  await call(base + '/Foreseerr/api/v1/request', {
    cookie,
    body: {},
    expected: 403,
  });
  await call(base + '/Foreseerr/api/v1/auth/jellyfin/plugin', {
    cookie,
    body: {},
    headers: { Origin: origin },
    expected: 404,
  });
  const settings = await (
    await call(base + '/Foreseerr/api/v1/settings/jellyfin', { cookie })
  ).json();
  assert.equal(settings.urlBase, base);
  assert.ok(settings.apiKey);
  // A browser cannot supply a different Foreseerr identity via API-key headers.
  const same = await (
    await call(base + '/Foreseerr/api/v1/auth/me', {
      cookie,
      headers: { 'X-API-Key': 'forged', 'X-API-User': '999' },
    })
  ).json();
  assert.equal(same.id, me.id);
  const secondToken = await login();
  const secondCookie = await sso(secondToken);
  await call(base + '/Foreseerr/api/v1/auth/logout', {
    cookie,
    method: 'POST',
    headers: { Origin: origin },
  });
  await call(base + '/Foreseerr/api/v1/auth/me', { cookie, expected: 401 });
  await call(base + '/Foreseerr/api/v1/auth/me', { cookie: secondCookie });
  cookie = await sso(token);
  await call(base + '/Sessions/Logout', {
    token,
    method: 'POST',
    expected: 204,
  });
  await call(base + '/Foreseerr/api/v1/auth/me', { cookie, expected: 401 });
  await call(base + '/Foreseerr/api/v1/auth/me', { cookie: secondCookie });

  // The dashboard never sees the managed secrets, and the public URL gains
  // Jellyfin's base path.
  const configPath = `${base}/Plugins/a7c3e2f1-9b4d-4e8a-8c1f-2b6d9e0f4a11/Configuration`;
  const config = await (await call(configPath, { token: secondToken })).json();
  assert.ok(!('PluginSecret' in config) && !('ApiKeyToken' in config));
  await call(configPath, {
    token: secondToken,
    body: { PublicServerUrl: 'jellyfin.example.test' },
    expected: 400,
  });
  const mainPath = base + '/Foreseerr/api/v1/settings/main';
  const readMain = async () =>
    (await call(mainPath, { cookie: secondCookie })).json();
  // Saving restarts the sidecar, which re-reads the plugin settings.
  const save = async (PublicServerUrl) => {
    const before = (
      await (await call(statusPath, { token: secondToken })).json()
    ).pid;
    await call(configPath, {
      token: secondToken,
      body: { PublicServerUrl },
      expected: 204,
    });
    return waitFor(async () => {
      const next = await (
        await call(statusPath, { token: secondToken })
      ).json();
      assert.ok(next.ready && next.pid !== before, 'Sidecar is restarting');
      return next;
    });
  };
  const restarted = await save('https://jellyfin.example.test/');
  assert.equal(restarted.publicUrl, `https://jellyfin.example.test${base}`);
  assert.equal(
    (await readMain()).applicationUrl,
    `https://jellyfin.example.test${base}/Foreseerr`
  );
  // Clearing the field removes only what the plugin set; an Application URL
  // entered in Foreseerr survives restarts.
  await save('');
  assert.equal((await readMain()).applicationUrl, '');
  await call(mainPath, {
    cookie: secondCookie,
    body: { applicationUrl: 'https://own.example.test' },
    headers: { Origin: origin },
  });
  await save('');
  assert.equal((await readMain()).applicationUrl, 'https://own.example.test');
  console.log(
    `PASS Jellyfin ${abi}: install, readiness, ephemeral port, subpath SPA/assets, SSO, API validation, avatar ids, sign-in page, ticket rotation, CSRF, mint isolation, header isolation, device isolation, logout and token revocation, managed settings, public URL and its provenance`
  );
} catch (error) {
  const logs = await command(['docker', 'logs', '--tail', '180', name]).catch(
    () => 'No container logs'
  );
  const logPath = join(tmpdir(), `foreseerr-jellyfin-proof-${abi}.log`);
  await writeFile(logPath, logs, { mode: 0o600 });
  console.error(`Diagnostic log: ${logPath}`);
  throw error;
} finally {
  await command(['docker', 'rm', '-f', name]).catch(() => {});
  await rm(fixture, { recursive: true, force: true }).catch((error) =>
    console.error(`Fixture cleanup: ${error.message}`)
  );
}
