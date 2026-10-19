import SimklAPI, {
  SimklNotConfiguredError,
  SimklOAuthError,
  SimklRequestError,
  SimklTemporarilyUnavailableError,
  SimklUnauthorizedError,
  simklErrorDetail,
} from '@server/api/simkl';
import { SIMKL_BUILTIN_CLIENT_ID } from '@server/constants/simkl';
import { getSettings } from '@server/lib/settings';
import axios, {
  AxiosError,
  type AxiosAdapter,
  type InternalAxiosRequestConfig,
} from 'axios';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

const previousAxiosAdapter = axios.defaults.adapter;

afterEach(() => {
  axios.defaults.adapter = previousAxiosAdapter;
});

/** The client builds its axios instance on construction, so stub first. */
const clientAnswering = (status: number, data: unknown) => {
  const urls: string[] = [];
  axios.defaults.adapter = (async (config) => {
    urls.push(String(config.url));
    const response = {
      status,
      statusText: '',
      headers: {},
      config,
      data,
    };
    if (status < 400) return response;
    throw new AxiosError(
      `Request failed with status code ${status}`,
      AxiosError.ERR_BAD_REQUEST,
      config,
      undefined,
      response
    );
  }) as AxiosAdapter;
  return { client: new SimklAPI({ clientId: 'test-client' }), urls };
};

type Call = { url: string; body: string; authorization?: string };

/** Answers each request from `route`, keyed on the path without its query. */
const stubSimkl = (
  route: (path: string, call: Call) => { status: number; data: unknown }
) => {
  const calls: Call[] = [];
  axios.defaults.adapter = (async (config: InternalAxiosRequestConfig) => {
    const call = {
      url: String(config.url),
      body: String(config.data ?? ''),
      authorization: config.headers?.Authorization as string | undefined,
    };
    calls.push(call);
    const { status, data } = route(call.url.split('?')[0], call);
    const response = { status, statusText: '', headers: {}, config, data };
    if (status < 400) return response;
    throw new AxiosError(
      `Request failed with status code ${status}`,
      AxiosError.ERR_BAD_REQUEST,
      config,
      undefined,
      response
    );
  }) as AxiosAdapter;
  return calls;
};

const V1_CLIENT = {
  status: 401,
  data: {
    error: 'invalid_client',
    error_description: 'This client_id is not enabled for OAuth 2.0',
  },
};

describe('SimklAPI errors', () => {
  it('keeps Simkl’s own reason for a rejected request', async () => {
    const { client } = clientAnswering(412, {
      error: 'client_id_failed',
      code: 412,
      message: 'Your client_id is wrong. Try another one',
    });
    await assert.rejects(client.requestPinCode(), (error: unknown) => {
      assert.ok(error instanceof SimklRequestError);
      assert.equal(error.status, 412);
      assert.equal(
        error.message,
        'Simkl rejected the request (HTTP 412): client_id_failed — Your client_id is wrong. Try another one'
      );
      return true;
    });
  });

  it('reduces a proxy’s HTML error page to its text', () => {
    assert.equal(
      simklErrorDetail(
        '<html><body><h1>400 Bad Request</h1>\n<p>Invalid header</p></body></html>'
      ),
      '400 Bad Request Invalid header'
    );
    assert.equal(simklErrorDetail(''), undefined);
    assert.equal(simklErrorDetail({}), undefined);
  });

  it('caps a long JSON reason like a text one', () => {
    assert.equal(
      simklErrorDetail({ error: 'bad', message: 'x'.repeat(500) })?.length,
      200
    );
  });

  it('validates an AUTH V2 Client ID against the device endpoint', async () => {
    const calls = stubSimkl(() => ({
      status: 200,
      data: { device_code: 'secret', user_code: 'BDWP-HQPK' },
    }));
    await new SimklAPI({ clientId: 'test-client' }).validateClientId();
    assert.deepEqual(
      calls.map((call) => call.url.split('?')[0]),
      ['/oauth2/device']
    );
  });

  it('validates a V1 Client ID against the PIN endpoint', async () => {
    const calls = stubSimkl((path) =>
      path === '/oauth2/device'
        ? V1_CLIENT
        : { status: 200, data: { result: 'OK', user_code: 'ABCDE' } }
    );
    await new SimklAPI({ clientId: 'test-client' }).validateClientId();
    assert.deepEqual(
      calls.map((call) => call.url.split('?')[0]),
      ['/oauth2/device', '/oauth/pin']
    );
  });

  it('reports an unknown Client ID with the V1 endpoint’s reason', async () => {
    stubSimkl((path) =>
      path === '/oauth2/device'
        ? V1_CLIENT
        : {
            status: 412,
            data: {
              error: 'client_id_failed',
              message: 'Your client_id is wrong',
            },
          }
    );
    await assert.rejects(
      new SimklAPI({ clientId: 'test-client' }).validateClientId(),
      /HTTP 412\): client_id_failed — Your client_id is wrong/
    );
  });
});

describe('SimklAPI AUTH V2', () => {
  it('uses Foreseerr’s app unless a custom Client ID is set', async () => {
    const calls = stubSimkl(() => ({ status: 200, data: {} }));
    const settings = getSettings();
    settings.simkl = { ...settings.simkl, enabled: true, clientId: '' };
    await new SimklAPI().getActivities();
    settings.simkl = { ...settings.simkl, clientId: ' own-client ' };
    await new SimklAPI().getActivities();
    settings.simkl = { ...settings.simkl, enabled: false };
    assert.throws(() => new SimklAPI(), SimklNotConfiguredError);
    settings.simkl = { ...settings.simkl, enabled: true, clientId: '' };
    assert.deepEqual(
      calls.map((call) =>
        new URL(call.url, 'http://x').searchParams.get('client_id')
      ),
      [SIMKL_BUILTIN_CLIENT_ID, 'own-client']
    );
  });

  it('requests a device code with both scopes as a form', async () => {
    const calls = stubSimkl(() => ({
      status: 200,
      data: { device_code: 'secret', user_code: 'BDWP-HQPK' },
    }));
    await new SimklAPI({ clientId: 'test-client' }).requestDeviceCode();
    const body = new URLSearchParams(calls[0].body);
    assert.equal(body.get('client_id'), 'test-client');
    assert.equal(body.get('scope'), 'media:read media:write');
  });

  it('exposes the OAuth error code and never treats it as a user 401', async () => {
    let unauthorized = 0;
    stubSimkl(() => V1_CLIENT);
    const client = new SimklAPI({
      clientId: 'test-client',
      onUnauthorized: async () => {
        unauthorized++;
      },
    });
    await assert.rejects(client.pollDeviceToken('secret'), (error: unknown) => {
      assert.ok(error instanceof SimklOAuthError);
      assert.equal(error.code, 'invalid_client');
      assert.equal(error.status, 401);
      return true;
    });
    assert.equal(unauthorized, 0);
  });

  it('refreshes a token about to expire before using it', async () => {
    const calls = stubSimkl(() => ({ status: 200, data: {} }));
    const stale: string[] = [];
    const client = new SimklAPI({
      clientId: 'test-client',
      accessToken: 'old',
      tokenExpiresAt: Math.floor(Date.now() / 1000) + 60,
      refreshTokens: async (token) => {
        stale.push(token);
        return {
          accessToken: 'new',
          expiresAt: Math.floor(Date.now() / 1000) + 604800,
        };
      },
    });
    await client.getActivities();
    await client.getActivities();
    assert.deepEqual(stale, ['old']);
    assert.deepEqual(
      calls.map((call) => call.authorization),
      ['Bearer new', 'Bearer new']
    );
  });

  it('keeps using a still-valid token when an early refresh fails', async () => {
    const calls = stubSimkl(() => ({ status: 200, data: { all: 1 } }));
    const client = new SimklAPI({
      clientId: 'test-client',
      accessToken: 'current',
      tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      refreshTokens: async () => {
        throw new SimklTemporarilyUnavailableError();
      },
    });
    assert.deepEqual(await client.getActivities(), { all: 1 });
    assert.equal(calls[0].authorization, 'Bearer current');
  });

  it('fails when an expired token cannot be refreshed', async () => {
    stubSimkl(() => ({ status: 200, data: {} }));
    const client = new SimklAPI({
      clientId: 'test-client',
      accessToken: 'expired',
      tokenExpiresAt: Math.floor(Date.now() / 1000) - 60,
      refreshTokens: async () => {
        throw new SimklTemporarilyUnavailableError();
      },
    });
    await assert.rejects(
      client.getActivities(),
      SimklTemporarilyUnavailableError
    );
  });

  it('refreshes once after a 401 and repeats the request', async () => {
    const calls = stubSimkl((_, call) =>
      call.authorization === 'Bearer new'
        ? { status: 200, data: { all: 1 } }
        : { status: 401, data: {} }
    );
    let unauthorized = 0;
    const client = new SimklAPI({
      clientId: 'test-client',
      accessToken: 'old',
      refreshTokens: async () => ({ accessToken: 'new' }),
      onUnauthorized: async () => {
        unauthorized++;
      },
    });
    assert.deepEqual(await client.getActivities(), { all: 1 });
    assert.equal(calls.length, 2);
    assert.equal(unauthorized, 0);
  });

  it('gives up when the refreshed token is rejected too', async () => {
    const calls = stubSimkl(() => ({ status: 401, data: {} }));
    let unauthorized = 0;
    const client = new SimklAPI({
      clientId: 'test-client',
      accessToken: 'old',
      refreshTokens: async () => ({ accessToken: 'new' }),
      onUnauthorized: async () => {
        unauthorized++;
      },
    });
    await assert.rejects(client.getActivities(), SimklUnauthorizedError);
    assert.equal(calls.length, 2);
    assert.equal(unauthorized, 1);
  });
});
