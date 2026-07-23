import yaml from 'js-yaml';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

describe('OpenAPI media-actions contract', () => {
  const apiSpecPath = join(__dirname, '../../seerr-api.yml');
  const apiDocs = yaml.load(readFileSync(apiSpecPath, 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };

  const requiredPaths: Record<string, string[]> = {
    '/media-actions/status-batch': ['post'],
    '/media-actions/{mediaType}/{tmdbId}/status': ['get'],
    '/media-actions/{mediaType}/{tmdbId}/watched': ['post'],
    '/media-actions/{mediaType}/{tmdbId}/unwatched': ['post'],
    '/media-actions/{mediaType}/{tmdbId}/rate': ['post'],
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

  it('caps status-batch items with maxItems', () => {
    const operation = apiDocs.paths['/media-actions/status-batch']?.post as {
      requestBody?: {
        content?: {
          'application/json'?: {
            schema?: { properties?: { items?: { maxItems?: number } } };
          };
        };
      };
    };
    assert.equal(
      operation.requestBody?.content?.['application/json']?.schema?.properties
        ?.items?.maxItems,
      100
    );
  });
});
