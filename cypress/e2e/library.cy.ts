const movieItem = {
  mediaType: 'movie',
  jellyfinItemId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  playItemId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  inspectorItemId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  title: 'Dune',
  year: 2021,
  posterUrl:
    '/api/v1/library/items/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/images/primary',
  mediaUrl: 'https://jellyfin.example/web/dune',
};

const seriesItem = {
  mediaType: 'tv',
  jellyfinItemId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  jellyfinSeriesId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  inspectorItemId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  title: 'Foundation',
  year: 2021,
  posterUrl:
    '/api/v1/library/items/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/images/primary',
};

describe('Library', () => {
  beforeEach(() => {
    cy.viewport(1280, 800);
    cy.loginAsAdmin();
    cy.intercept('GET', '/api/v1/library/watch-now', {
      shelves: [
        {
          id: 'continue',
          title: 'Continue Watching',
          items: [
            {
              ...movieItem,
              subtitle: '1h 12m left',
              progressPercent: 40,
              backdropUrl:
                '/api/v1/library/items/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/images/backdrop',
            },
          ],
        },
        {
          id: 'recent',
          title: 'Recently Added',
          items: [seriesItem],
        },
      ],
    }).as('watchNow');
    cy.intercept('GET', '/api/v1/library/facets', {
      genres: ['Drama', 'Sci-Fi'],
      yearMin: 1990,
      yearMax: 2024,
    }).as('facets');
    cy.intercept('GET', '/api/v1/library/browse*', {
      pageInfo: { pages: 1, pageSize: 24, results: 2, page: 1 },
      results: [movieItem, seriesItem],
    }).as('browse');
    cy.intercept(
      'GET',
      '/api/v1/library/items/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      {
        jellyfinItemId: movieItem.jellyfinItemId,
        mediaType: 'movie',
        title: 'Dune',
        overview: 'Arrakis.',
        year: 2021,
        playItemId: movieItem.playItemId,
        playUrl: movieItem.mediaUrl,
        mediaUrl: movieItem.mediaUrl,
      }
    ).as('movieInspector');
    cy.intercept(
      'GET',
      '/api/v1/library/items/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      {
        jellyfinItemId: seriesItem.jellyfinItemId,
        jellyfinSeriesId: seriesItem.jellyfinSeriesId,
        mediaType: 'tv',
        title: 'Foundation',
        playItemId: 'cccccccccccccccccccccccccccccccc',
        playUrl: 'https://jellyfin.example/web/ep',
        seasons: [
          { jellyfinSeasonId: 'season-1', name: 'Season 1', indexNumber: 1 },
        ],
      }
    ).as('seriesInspector');
    cy.intercept(
      'GET',
      '/api/v1/library/series/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/seasons/season-1/episodes',
      {
        jellyfinSeriesId: seriesItem.jellyfinSeriesId,
        jellyfinSeasonId: 'season-1',
        episodes: [
          {
            jellyfinItemId: 'cccccccccccccccccccccccccccccccc',
            name: 'The Emperor',
            indexNumber: 1,
            parentIndexNumber: 1,
            subtitle: 'S1E1',
            mediaUrl: 'https://jellyfin.example/web/ep',
            watched: false,
          },
        ],
      }
    ).as('episodes');
  });

  it('renders overview shelves and opens browse', () => {
    cy.visit('/library');
    cy.wait('@watchNow');
    cy.contains('Continue Watching');
    cy.get('[data-testid=library-resume-card]').should('contain', 'Dune');
    cy.contains('[data-testid=library-poster-card]', 'Foundation');
    cy.contains('a', 'Browse').click();
    cy.url().should('include', '/library/browse');
    cy.wait('@browse');
    cy.get('[data-testid=library-poster-card]').should('contain', 'Dune');
  });

  it('updates the browse URL from search and sort', () => {
    cy.visit('/library/browse');
    cy.wait('@browse');
    cy.get('input[type=search]').type('dune');
    cy.url().should('include', 'q=dune');
    cy.contains('button', 'Movies').click();
    cy.url().should('include', 'mediaType=movie');
  });

  it('opens a movie inspector and does not restore it after manage close', () => {
    cy.intercept('GET', '/api/v1/movie/123', {
      id: 123,
      title: 'Dune',
      mediaInfo: { serviceId: 1, externalServiceId: 9 },
    }).as('movieDetails');
    cy.intercept(
      'GET',
      '/api/v1/library/items/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      {
        jellyfinItemId: movieItem.jellyfinItemId,
        mediaType: 'movie',
        title: 'Dune',
        tmdbId: 123,
        mediaId: 1,
        playItemId: movieItem.playItemId,
        playUrl: movieItem.mediaUrl,
      }
    ).as('movieInspectorMapped');
    cy.visit('/library/browse');
    cy.wait('@browse');
    cy.contains('[data-testid=library-poster-card]', 'Dune')
      .find('button[aria-label="Dune"]')
      .click();
    cy.wait('@movieInspectorMapped');
    cy.get('[role=dialog]').should('contain', 'Dune');
    cy.get('[role=dialog]').should('contain', 'Play');
  });

  it('opens a series inspector with season episodes', () => {
    cy.visit('/library/browse');
    cy.wait('@browse');
    cy.contains('[data-testid=library-poster-card]', 'Foundation')
      .find('button[aria-label="Foundation"]')
      .click();
    cy.wait('@seriesInspector');
    cy.wait('@episodes');
    cy.get('[role=dialog]').should('contain', 'Foundation');
    cy.get('[role=dialog]').should('contain', 'The Emperor');
  });

  it('shows unsupported library state', () => {
    cy.intercept('GET', '/api/v1/library/browse*', {
      pageInfo: { pages: 1, pageSize: 24, results: 0, page: 1 },
      results: [],
      code: 'unsupported_media_server',
    }).as('unsupported');
    cy.visit('/library/browse');
    cy.wait('@unsupported');
    cy.contains('Complete Library browse requires a Jellyfin media server.');
  });

  it('keeps play off browse posters and toggles genres in the filter panel', () => {
    cy.visit('/library/browse');
    cy.wait('@browse');
    cy.contains('[data-testid=library-poster-card]', 'Dune').should(
      'not.contain',
      'Play'
    );
    cy.contains('button', 'Active Filter').click();
    cy.contains('button', 'Drama').click();
    cy.url().should('include', 'genre=Drama');
    cy.contains('button', 'Unwatched').click();
    cy.url().should('include', 'watched=unwatched');
  });
});
