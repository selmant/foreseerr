import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MovieApiQuerySchema, TvApiQuerySchema } from './filterOptions';

describe('TMDB discover sort options', () => {
  it('accepts the title sort field for each media type', () => {
    assert.equal(
      MovieApiQuerySchema.parse({ sortBy: 'original_title.asc' }).sortBy,
      'original_title.asc'
    );
    assert.equal(
      TvApiQuerySchema.parse({ sortBy: 'original_name.asc' }).sortBy,
      'original_name.asc'
    );
  });

  it('ignores an invalid or cross-media sort field', () => {
    assert.equal(
      MovieApiQuerySchema.parse({ sortBy: 'original_name.asc' }).sortBy,
      undefined
    );
    assert.equal(
      TvApiQuerySchema.parse({ sortBy: 'original_title.asc' }).sortBy,
      undefined
    );
    assert.equal(
      TvApiQuerySchema.parse({ sortBy: 'unknown' }).sortBy,
      undefined
    );
  });
});
