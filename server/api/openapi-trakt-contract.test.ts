import yaml from 'js-yaml';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * Fast contract checks: OpenAPI must declare Trakt routes or
 * express-openapi-validator returns {"message":"not found"} in production.
 */
describe('OpenAPI Trakt contract', () => {
  const apiSpecPath = join(__dirname, '../../seerr-api.yml');
  const apiDocs = yaml.load(readFileSync(apiSpecPath, 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };

  const requiredPaths: Record<string, string[]> = {
    '/settings/trakt': ['get', 'post'],
    '/settings/trakt/actions': ['post'],
    '/settings/integrations/status': ['get'],
    '/settings/integrations/status/refresh': ['post'],
    '/user/{userId}/settings/linked-accounts/trakt': ['get', 'delete'],
    '/user/{userId}/settings/linked-accounts/trakt/device/code': ['post'],
    '/user/{userId}/settings/linked-accounts/trakt/device/token': ['post'],
    '/discover/trakt/recommendations': ['get'],
    '/discover/trakt/watchlist': ['get'],
    '/discover/trakt/history': ['get'],
    '/discover/trakt/lists': ['get'],
    '/discover/trakt/lists/search': ['get'],
    '/discover/trakt/list': ['get'],
  };

  for (const [path, methods] of Object.entries(requiredPaths)) {
    it(`declares ${path} (${methods.join(', ')})`, () => {
      const pathItem = apiDocs.paths[path];
      assert.ok(pathItem, `missing OpenAPI path ${path}`);
      for (const method of methods) {
        assert.ok(
          pathItem[method],
          `missing ${method.toUpperCase()} ${path} in seerr-api.yml`
        );
      }
    });
  }
});
