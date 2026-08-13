import { hydrateForgottenLibraryTitles } from '@server/lib/library';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('hydrateForgottenLibraryTitles', () => {
  const base = {
    mediaType: 'movie' as const,
    jellyfinItemId: 'movie-1',
    title: 'Movie',
  };

  it('fills poster and backdrop when jellyfin item is missing', () => {
    const [out] = hydrateForgottenLibraryTitles([base], []);
    assert.equal(out.posterUrl, '/api/v1/library/items/movie-1/images/primary');
    assert.equal(
      out.backdropUrl,
      '/api/v1/library/items/movie-1/images/backdrop'
    );
    assert.equal(out.title, 'Movie');
  });

  it('replaces placeholder title and keeps request media ids', () => {
    const [out] = hydrateForgottenLibraryTitles(
      [{ ...base, mediaId: 9, tmdbId: 42 }],
      [
        {
          Id: 'movie-1',
          Type: 'Movie',
          Name: 'Dune',
          ProductionYear: 2021,
        },
      ]
    );
    assert.equal(out.title, 'Dune');
    assert.equal(out.year, 2021);
    assert.equal(out.posterUrl, '/api/v1/library/items/movie-1/images/primary');
    assert.equal(out.mediaId, 9);
    assert.equal(out.tmdbId, 42);
  });
});
