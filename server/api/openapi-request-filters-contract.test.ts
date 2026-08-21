import yaml from 'js-yaml';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

describe('OpenAPI request filter contract', () => {
  const apiSpecPath = join(__dirname, '../../seerr-api.yml');
  const apiDocs = yaml.load(readFileSync(apiSpecPath, 'utf8')) as {
    paths: Record<
      string,
      Record<string, { parameters?: { name?: string; $ref?: string }[] }>
    >;
    components: {
      schemas: Record<string, unknown>;
      parameters: Record<string, { name: string }>;
    };
  };

  const resolveParameterNames = (
    parameters: { name?: string; $ref?: string }[] = []
  ): string[] =>
    parameters.map((parameter) => {
      if (parameter.name) {
        return parameter.name;
      }
      const refKey = parameter.$ref?.split('/').pop();
      return refKey ? apiDocs.components.parameters[refKey]?.name : '';
    });

  const browseExternalRatingParams = [
    'imdbRatingGte',
    'imdbRatingLte',
    'imdbVotesGte',
    'imdbVotesLte',
    'rtCriticsGte',
    'rtCriticsLte',
    'rtAudienceGte',
    'rtAudienceLte',
    'metacriticGte',
    'metacriticLte',
    'traktRatingGte',
    'traktRatingLte',
    'includeNoRating',
  ];

  it('declares MDBList browse filter query params on discover routes', () => {
    for (const path of [
      '/discover/movies',
      '/discover/tv',
      '/discover/trending',
      '/discover/trakt/history',
    ]) {
      const parameterNames = resolveParameterNames(
        apiDocs.paths[path]?.get?.parameters
      );
      for (const name of browseExternalRatingParams) {
        assert.ok(
          parameterNames.includes(name),
          `missing ${name} on GET ${path}`
        );
      }
    }
  });

  it('declares Discover default-control query params on regular browse routes', () => {
    for (const path of [
      '/discover/movies',
      '/discover/tv',
      '/discover/trending',
    ]) {
      const parameterNames = resolveParameterNames(
        apiDocs.paths[path]?.get?.parameters
      );
      assert.ok(parameterNames.includes('ignoreWatched'));
      assert.ok(parameterNames.includes('ignoreDiscoverDefaults'));
      assert.ok(parameterNames.includes('ignoreCollected'));
      assert.ok(parameterNames.includes('ignoreWatchlisted'));
      assert.ok(parameterNames.includes('hideUnmapped'));
    }
  });
});
