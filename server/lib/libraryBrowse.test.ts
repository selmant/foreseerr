import {
  buildJellyfinBrowseParams,
  isJellyfinItemId,
  jellyfinItemImageRequest,
  libraryTitleDisplayFields,
  listBrowseFromClient,
  uniqueSortedGenres,
} from '@server/lib/libraryBrowse';
import { parseLibraryBrowseQuery } from '@server/lib/libraryBrowseQuery';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('buildJellyfinBrowseParams', () => {
  it('maps watched state, sort, media type, and pagination', () => {
    const params = buildJellyfinBrowseParams(
      parseLibraryBrowseQuery({
        mediaType: 'tv',
        watched: 'inProgress',
        sort: 'lastPlayed',
        order: 'asc',
        take: '12',
        skip: '24',
      }),
      'user-1'
    );
    assert.equal(params.IncludeItemTypes, 'Series');
    assert.equal(params.Filters, 'IsResumable');
    assert.equal(params.SortBy, 'DatePlayed');
    assert.equal(params.SortOrder, 'Ascending');
    assert.equal(params.StartIndex, 24);
    assert.equal(params.Limit, 12);
    assert.equal(params.userId, 'user-1');
    assert.equal(params.Recursive, true);
  });

  it('maps unwatched and played filters', () => {
    assert.equal(
      buildJellyfinBrowseParams(
        parseLibraryBrowseQuery({ watched: 'unwatched' }),
        'u'
      ).Filters,
      'IsUnplayed'
    );
    assert.equal(
      buildJellyfinBrowseParams(
        parseLibraryBrowseQuery({ watched: 'played' }),
        'u'
      ).Filters,
      'IsPlayed'
    );
  });

  it('maps year bounds and comma-joined genres', () => {
    const params = buildJellyfinBrowseParams(
      parseLibraryBrowseQuery({
        genre: ['Action', 'Drama'],
        yearFrom: '1990',
        yearTo: '2024',
      }),
      'u'
    );
    assert.equal(params.Genres, 'Action,Drama');
    assert.equal(params.MinPremiereDate, '1990-01-01');
    assert.equal(params.MaxPremiereDate, '2024-12-31');
  });

  it('omits empty search and default movie+series include', () => {
    const params = buildJellyfinBrowseParams(parseLibraryBrowseQuery({}), 'u');
    assert.equal(params.SearchTerm, undefined);
    assert.equal(params.IncludeItemTypes, 'Movie,Series');
    assert.equal(params.SortBy, 'DateCreated');
    assert.equal(params.SortOrder, 'Descending');
  });

  it('maps title and premiere sorts', () => {
    assert.equal(
      buildJellyfinBrowseParams(parseLibraryBrowseQuery({ sort: 'title' }), 'u')
        .SortBy,
      'SortName'
    );
    assert.equal(
      buildJellyfinBrowseParams(
        parseLibraryBrowseQuery({ sort: 'premiereDate' }),
        'u'
      ).SortBy,
      'PremiereDate'
    );
  });
});

describe('libraryTitleDisplayFields', () => {
  it('sets inspector target to series for episodes', () => {
    const fields = libraryTitleDisplayFields({
      Id: 'ep-1',
      Type: 'Episode',
      SeriesId: 'series-1',
      ProductionYear: 2020,
      Genres: ['Drama'],
      BackdropImageTags: ['tag'],
      UserData: { Played: false, PlayedPercentage: 40 },
    });
    assert.equal(fields.inspectorItemId, 'series-1');
    assert.equal(fields.inProgress, true);
    assert.equal(fields.watched, false);
    assert.equal(
      fields.posterUrl,
      '/api/v1/library/items/series-1/images/primary'
    );
    assert.equal(
      fields.backdropUrl,
      '/api/v1/library/items/ep-1/images/backdrop'
    );
  });

  it('keeps movie and series posters on the item itself', () => {
    const movie = libraryTitleDisplayFields({
      Id: 'movie-1',
      Type: 'Movie',
    });
    const series = libraryTitleDisplayFields({
      Id: 'series-1',
      Type: 'Series',
    });
    assert.equal(
      movie.posterUrl,
      '/api/v1/library/items/movie-1/images/primary'
    );
    assert.equal(
      series.posterUrl,
      '/api/v1/library/items/series-1/images/primary'
    );
  });

  it('exposes unplayed episode count on series without treating completion as resume', () => {
    const fields = libraryTitleDisplayFields({
      Id: 'series-1',
      Type: 'Series',
      UserData: {
        Played: false,
        PlayedPercentage: 40,
        UnplayedItemCount: 12,
        LastPlayedDate: '2026-08-01T00:00:00Z',
      },
    });
    assert.equal(fields.watched, false);
    assert.equal(fields.inProgress, false);
    assert.equal(fields.unplayedItemCount, 12);
  });
});

describe('listBrowseFromClient', () => {
  it('forwards filters and pagination and keeps movie play targets only', async () => {
    let forwarded: Record<string, string | number | boolean> | undefined;
    const result = await listBrowseFromClient(
      {
        browseLibraryItems: async (params) => {
          forwarded = params;
          return {
            totalRecordCount: 2,
            items: [
              {
                Id: 'movie-1',
                Type: 'Movie',
                Name: 'Dune',
                HasSubtitles: false,
                LocationType: 'FileSystem',
                MediaType: 'Video',
                ProviderIds: {},
              },
              {
                Id: 'series-1',
                Type: 'Series',
                Name: 'Foundation',
                HasSubtitles: false,
                LocationType: 'FileSystem',
                MediaType: 'Video',
                ProviderIds: {},
              },
            ],
          };
        },
      },
      'jf-user',
      parseLibraryBrowseQuery({
        genre: ['Sci-Fi'],
        yearFrom: '2020',
        take: '10',
        skip: '10',
      }),
      async (items) =>
        items.map((item) => ({
          mediaType: item.Type === 'Movie' ? 'movie' : 'tv',
          jellyfinItemId: item.Id,
          title: item.Name,
          playItemId: item.Type === 'Movie' ? item.Id : undefined,
          mediaId: item.Id === 'movie-1' ? 42 : undefined,
        }))
    );

    assert.equal(forwarded?.Genres, 'Sci-Fi');
    assert.equal(forwarded?.MinPremiereDate, '2020-01-01');
    assert.equal(forwarded?.StartIndex, 10);
    assert.equal(forwarded?.Limit, 10);
    assert.equal(result.total, 2);
    assert.equal(result.results[0].playItemId, 'movie-1');
    assert.equal(result.results[0].mediaId, 42);
    assert.equal(result.results[1].playItemId, undefined);
  });
});

describe('uniqueSortedGenres', () => {
  it('trims, de-dupes case-insensitively, and sorts', () => {
    assert.deepEqual(
      uniqueSortedGenres([' Drama', 'action', 'Action', '', 'Sci-Fi', null]),
      ['action', 'Drama', 'Sci-Fi']
    );
  });
});

describe('jellyfinItemImageRequest', () => {
  it('maps image types without embedding a token', () => {
    const primary = jellyfinItemImageRequest(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'primary'
    );
    const backdrop = jellyfinItemImageRequest(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'backdrop'
    );
    assert.equal(
      primary.path,
      '/Items/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Images/Primary'
    );
    assert.equal(primary.params.maxWidth, 400);
    assert.equal(
      backdrop.path,
      '/Items/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/Images/Backdrop'
    );
    assert.equal(backdrop.params.maxWidth, 1280);
    assert.equal(JSON.stringify(primary).includes('Token'), false);
  });

  it('rejects non-hex item ids', () => {
    assert.equal(isJellyfinItemId('not-an-id'), false);
    assert.equal(isJellyfinItemId('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), true);
  });
});
