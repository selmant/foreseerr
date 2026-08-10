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
    components: { schemas: Record<string, Record<string, unknown>> };
  };

  const requiredPaths: Record<string, string[]> = {
    '/library/watch-now': ['get'],
    '/library/available': ['get'],
    '/library/search': ['get'],
    '/library/series/{jellyfinSeriesId}': ['get'],
    '/library/series/{jellyfinSeriesId}/seasons/{seasonId}/episodes': ['get'],
    '/media/{mediaId}/servarr/context': ['get'],
    '/media/{mediaId}/servarr/releases': ['get', 'post'],
    '/media/{mediaId}/servarr/imports/sources': ['get'],
    '/media/{mediaId}/servarr/imports/scan': ['post'],
    '/media/{mediaId}/servarr/imports/reprocess': ['post'],
    '/media/{mediaId}/servarr/imports': ['get', 'post'],
    '/media/{mediaId}/servarr/commands/{token}': ['get'],
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

  it('declares series panel schemas and play-target fields', () => {
    const title = apiDocs.components.schemas.LibraryTitle as {
      properties: Record<string, unknown>;
    };
    assert.ok(title.properties.playItemId);
    assert.ok(title.properties.jellyfinSeriesId);
    assert.ok(apiDocs.components.schemas.LibrarySeriesDetailResponse);
    assert.ok(apiDocs.components.schemas.LibrarySeasonEpisodesResponse);
    assert.ok(apiDocs.components.schemas.LibraryEpisode);
    assert.ok(apiDocs.components.schemas.LibrarySeriesSeason);

    const shelf = apiDocs.components.schemas.LibraryShelf as {
      properties: { id: { enum: string[] } };
    };
    assert.ok(shelf.properties.id.enum.includes('recent-episodes'));
  });

  it('documents Arr-only manual import eligibility', () => {
    const sources = apiDocs.paths['/media/{mediaId}/servarr/imports/sources']
      .get as { description: string };
    const imports = apiDocs.paths['/media/{mediaId}/servarr/imports'].get as {
      description: string;
    };
    assert.match(sources.description, /completed queue downloads/i);
    assert.match(sources.description, /import warning/i);
    assert.match(imports.description, /marked for manual import/i);
  });
});
