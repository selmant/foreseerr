import yaml from 'js-yaml';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * OpenAPI must declare library routes or express-openapi-validator
 * returns {"message":"not found"} in production.
 */
describe('OpenAPI library contract', () => {
  const apiSpecPath = join(__dirname, '../../seerr-api.yml');
  const apiDocs = yaml.load(readFileSync(apiSpecPath, 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
    components: { schemas: Record<string, unknown> };
  };

  const requiredPaths: Record<string, string[]> = {
    '/library/watch-now': ['get'],
    '/library/available': ['get'],
    '/library/search': ['get'],
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

  it('declares LibraryWatchNowResponse and LibraryTitle schemas', () => {
    assert.ok(apiDocs.components.schemas.LibraryTitle);
    assert.ok(apiDocs.components.schemas.LibraryShelf);
    assert.ok(apiDocs.components.schemas.LibraryWatchNowResponse);
    assert.ok(apiDocs.components.schemas.LibraryAvailableResponse);
  });
});
