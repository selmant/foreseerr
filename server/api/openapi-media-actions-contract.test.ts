import yaml from 'js-yaml';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

describe('OpenAPI media-actions contract', () => {
  const apiSpecPath = join(__dirname, '../../seerr-api.yml');
  const apiDocs = yaml.load(readFileSync(apiSpecPath, 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
    components: {
      schemas: Record<
        string,
        {
          required?: string[];
          properties?: Record<
            string,
            { enum?: string[]; items?: unknown; $ref?: string }
          >;
        }
      >;
    };
  };

  const requiredPaths: Record<string, string[]> = {
    '/media-actions/capabilities': ['get'],
    '/media-actions/status-batch': ['post'],
    '/media-actions/{mediaType}/{tmdbId}/status': ['get'],
    '/media-actions/{mediaType}/{tmdbId}/watched': ['post'],
    '/media-actions/{mediaType}/{tmdbId}/unwatched': ['post'],
    '/media-actions/{mediaType}/{tmdbId}/rate': ['post'],
    '/media-actions/tv/{tmdbId}/seasons/{seasonNumber}/episodes/status': [
      'get',
    ],
    '/media-actions/tv/{tmdbId}/seasons/{seasonNumber}/episodes/{episodeNumber}/watched':
      ['post'],
    '/media-actions/tv/{tmdbId}/seasons/{seasonNumber}/episodes/{episodeNumber}/unwatched':
      ['post'],
    '/media-actions/episodes/jellyfin/{jellyfinItemId}/watched': ['post'],
    '/media-actions/episodes/jellyfin/{jellyfinItemId}/unwatched': ['post'],
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

  it('documents episode write responses with outcome and providers', () => {
    const schema = apiDocs.components.schemas.EpisodeWatchWriteResult;
    assert.deepEqual(schema.required, ['outcome', 'watched', 'providers']);
    assert.deepEqual(schema.properties?.outcome?.enum, [
      'success',
      'partial',
      'failure',
    ]);
    assert.ok(schema.properties?.providers?.items);
  });

  it('includes jellyfin in MediaActionProviderResult provider enum', () => {
    const providerEnum =
      apiDocs.components.schemas.MediaActionProviderResult.properties?.provider
        ?.enum;
    assert.deepEqual(providerEnum, ['trakt', 'jellyfin']);
  });

  it('documents title-specific action availability', () => {
    const status = apiDocs.components.schemas.MediaActionStatus;
    assert.equal(
      status.properties?.actions?.$ref,
      '#/components/schemas/MediaActionItemAvailability'
    );
  });

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
