import yaml from 'js-yaml';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * Fast contract checks: OpenAPI must declare request-filters routes or
 * express-openapi-validator returns {"message":"not found"} in production.
 */
describe('OpenAPI request filters contract', () => {
  const apiSpecPath = join(__dirname, '../../seerr-api.yml');
  const apiDocs = yaml.load(readFileSync(apiSpecPath, 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
    components: { schemas: Record<string, unknown> };
  };

  it('declares /settings/request-filters (get, post)', () => {
    const pathItem = apiDocs.paths['/settings/request-filters'];
    assert.ok(pathItem, 'missing OpenAPI path /settings/request-filters');
    assert.ok(pathItem.get, 'missing GET /settings/request-filters');
    assert.ok(pathItem.post, 'missing POST /settings/request-filters');
  });

  it('declares RequestFiltersSettings schema', () => {
    assert.ok(apiDocs.components.schemas.RequestFiltersSettings);
  });
});
