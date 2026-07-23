import yaml from 'js-yaml';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * Fast contract checks: OpenAPI must declare MDBList/ratings routes or
 * express-openapi-validator returns {"message":"not found"} in production.
 */
describe('OpenAPI MDBList ratings contract', () => {
  const apiSpecPath = join(__dirname, '../../seerr-api.yml');
  const apiDocs = yaml.load(readFileSync(apiSpecPath, 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
    components: { schemas: Record<string, unknown> };
  };

  const requiredPaths: Record<string, string[]> = {
    '/settings/mdblist': ['get', 'post'],
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

  it('declares RatingResponse and MdbListSettings schemas', () => {
    assert.ok(apiDocs.components.schemas.RatingResponse);
    assert.ok(apiDocs.components.schemas.MdbListSettings);
    assert.ok(apiDocs.components.schemas.RatingBadgeSettings);
  });

  for (const schemaName of ['MovieResult', 'TvResult']) {
    it(`includes ratings in ${schemaName}`, () => {
      const schema = apiDocs.components.schemas[schemaName] as {
        properties?: Record<string, unknown>;
      };
      assert.ok(schema.properties?.ratings);
    });
  }
});
