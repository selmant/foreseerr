import SimklAPI, {
  SimklRequestError,
  simklErrorDetail,
} from '@server/api/simkl';
import axios, { AxiosError, type AxiosAdapter } from 'axios';
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

  it('validates the Client ID against the PIN endpoint', async () => {
    const { client, urls } = clientAnswering(200, {
      result: 'OK',
      user_code: 'ABCDE',
    });
    await client.validateClientId();
    assert.equal(urls.length, 1);
    assert.match(urls[0], /^\/oauth\/pin\?client_id=test-client&/);
  });
});
