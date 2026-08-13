import type { LibraryTitle } from '@server/interfaces/api/libraryInterfaces';
import {
  resolveInspectorTargetId,
  toInspectorResponse,
} from '@server/lib/library';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const movieTitle = (overrides: Partial<LibraryTitle> = {}): LibraryTitle => ({
  mediaType: 'movie',
  jellyfinItemId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  title: 'Dune',
  playItemId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  year: 2021,
  ...overrides,
});

describe('resolveInspectorTargetId', () => {
  it('resolves episode ids to the parent series', () => {
    assert.equal(
      resolveInspectorTargetId({
        Id: 'ep',
        Type: 'Episode',
        SeriesId: 'series-1',
      }),
      'series-1'
    );
  });

  it('keeps movie and series ids', () => {
    assert.equal(
      resolveInspectorTargetId({ Id: 'movie-1', Type: 'Movie' }),
      'movie-1'
    );
    assert.equal(
      resolveInspectorTargetId({ Id: 'series-1', Type: 'Series' }),
      'series-1'
    );
  });
});

describe('toInspectorResponse', () => {
  it('maps a movie title into the inspector payload', () => {
    const payload = toInspectorResponse(movieTitle({ overview: 'Arrakis' }), {
      playUrl: 'https://jellyfin.example/web',
    });
    assert.equal(payload.mediaType, 'movie');
    assert.equal(payload.overview, 'Arrakis');
    assert.equal(payload.playUrl, 'https://jellyfin.example/web');
    assert.equal(payload.seasons, undefined);
  });

  it('attaches series seasons and play-next', () => {
    const payload = toInspectorResponse(
      movieTitle({
        mediaType: 'tv',
        jellyfinSeriesId: 'series-1',
        title: 'Foundation',
      }),
      {
        seasons: [{ jellyfinSeasonId: 's1', name: 'Season 1', indexNumber: 1 }],
        playItemId: 'ep-1',
        subtitle: 'Up next S1E2',
      }
    );
    assert.equal(payload.mediaType, 'tv');
    assert.equal(payload.playItemId, 'ep-1');
    assert.equal(payload.seasons?.length, 1);
  });
});
