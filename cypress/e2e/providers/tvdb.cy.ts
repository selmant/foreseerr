describe('TVDB Integration', () => {
  // Constants for routes and selectors
  const ROUTES = {
    home: '/',
    metadataSettings: '/settings/metadata',
    tomorrowIsOursTvShow: '/tv/72879',
    monsterTvShow: '/tv/225634',
    dragonnBallZKaiAnime: '/tv/61709',
  };

  const SELECTORS = {
    sidebarToggle: '[data-testid=sidebar-toggle]',
    sidebarSettingsMobile: '[data-testid=sidebar-menu-settings-mobile]',
    settingsNavDesktop: 'nav[data-testid="settings-nav-desktop"]',
    metadataTestButton: 'button[type="button"]:contains("Test")',
    metadataSaveButton: '[data-testid="metadata-save-button"]',
    tmdbStatus: '[data-testid="tmdb-status"]',
    tvdbStatus: '[data-testid="tvdb-status"]',
    tvMetadataProviderSelector: '[data-testid="tv-metadata-provider-selector"]',
    animeMetadataProviderSelector:
      '[data-testid="anime-metadata-provider-selector"]',
    seasonSelector: '[data-testid="season-selector"]',
    season1: 'Season 1',
    season2: 'Season 2',
    season3: 'Season 3',
    episodeList: '[data-testid="episode-list"]',
    episode9: '9 - Hang Men',
  };

  const episodeSeason = {
    airDate: '2024-09-19',
    episodes: [
      {
        id: 101,
        name: 'Pilot',
        airDate: '2024-09-19',
        episodeNumber: 1,
        overview: 'Episode overview',
        productionCode: '',
        seasonNumber: 1,
        showId: 225634,
        voteAverage: 0,
        voteCount: 0,
      },
    ],
    externalIds: {},
    id: 1,
    name: 'Season 1',
    overview: '',
    seasonNumber: 1,
  };

  // Reusable commands
  const openMetadataSettings = () => {
    cy.visit(ROUTES.metadataSettings);
    cy.contains('h3', 'Metadata Providers').should('be.visible');
  };

  const testAndVerifyMetadataConnection = () => {
    cy.intercept('POST', '/api/v1/settings/metadatas/test').as(
      'testConnection'
    );
    cy.get(SELECTORS.metadataTestButton).click();
    return cy.wait('@testConnection');
  };

  const saveMetadataSettings = (customBody = null) => {
    if (customBody) {
      cy.intercept('PUT', '/api/v1/settings/metadatas', (req) => {
        req.body = customBody;
      }).as('saveMetadata');
    } else {
      // Else just intercept without modifying body
      cy.intercept('PUT', '/api/v1/settings/metadatas').as('saveMetadata');
    }

    cy.get(SELECTORS.metadataSaveButton).click();
    return cy.wait('@saveMetadata');
  };

  const interceptMediaActionCapabilities = () => {
    cy.intercept('GET', '/api/v1/media-actions/capabilities', {
      movie: { watched: true, rating: true },
      tv: { watched: true, rating: true },
      episode: { watched: true, rating: false },
      providers: [
        {
          id: 'trakt',
          linked: true,
          capabilities: {
            readWatched: true,
            writeWatched: true,
            readRating: true,
            writeRating: true,
          },
        },
      ],
    }).as('mediaActionCapabilities');
  };

  const patchMonsterTv = (
    patch: (body: Record<string, unknown>) => void,
    alias = 'monsterTv'
  ) => {
    cy.intercept('GET', '/api/v1/tv/225634', (req) => {
      delete req.headers['if-none-match'];
      req.continue((res) => {
        patch(res.body as Record<string, unknown>);
      });
    }).as(alias);
  };

  beforeEach(() => {
    // Perform login
    cy.login(Cypress.env('ADMIN_EMAIL'), Cypress.env('ADMIN_PASSWORD'));
    interceptMediaActionCapabilities();

    openMetadataSettings();

    // Configure TVDB as TV provider and test connection
    cy.get(SELECTORS.tvMetadataProviderSelector).click();

    // get id react-select-4-option-1
    cy.get('[class*="react-select__option"]').contains('TheTVDB').click();

    // Test the connection
    testAndVerifyMetadataConnection().then(({ response }) => {
      expect(response.statusCode).to.equal(200);
      // Check TVDB connection status
      cy.get(SELECTORS.tvdbStatus).should('contain', 'Operational');
    });

    // Save settings
    saveMetadataSettings({
      anime: 'tvdb',
      tv: 'tvdb',
    }).then(({ response }) => {
      expect(response.statusCode).to.equal(200);
      expect(response.body.tv).to.equal('tvdb');
    });
  });

  it('should display "Tomorrow is Ours" show information with multiple seasons from TVDB', () => {
    // Navigate to the TV show
    cy.visit(ROUTES.tomorrowIsOursTvShow);

    // Verify that multiple seasons are displayed (TMDB has only 1 season, TVDB has multiple)
    // cy.get(SELECTORS.seasonSelector).should('exist');
    cy.intercept('/api/v1/tv/225634/season/1').as('season1');
    // Select Season 2 and verify it loads
    cy.contains(SELECTORS.season2)
      .should('be.visible')
      .scrollIntoView()
      .click();

    // Verify that episodes are displayed for Season 2
    cy.contains('260 - Episode 506').should('be.visible');
  });

  it('Should display "Monster" show information correctly when not existing on TVDB', () => {
    // Navigate to the TV show
    cy.visit(ROUTES.monsterTvShow);

    // Intercept season 1 request
    cy.intercept('/api/v1/tv/225634/season/1').as('season1');

    // Select Season 1
    cy.contains(SELECTORS.season1)
      .should('be.visible')
      .scrollIntoView()
      .click();

    // Wait for the season data to load
    cy.wait('@season1');

    // Verify specific episode exists
    cy.contains(SELECTORS.episode9).should('be.visible');
  });

  it('should display "Dragon Ball Z Kai" show information with multiple only 2 seasons from TVDB', () => {
    // Navigate to the TV show
    cy.visit(ROUTES.dragonnBallZKaiAnime);

    // Intercept season 1 request
    cy.intercept('/api/v1/tv/61709/season/1').as('season1');

    // Select Season 2 and verify it visible
    cy.contains(SELECTORS.season2)
      .should('be.visible')
      .scrollIntoView()
      .click();

    // select season 3 and verify it not visible
    cy.contains(SELECTORS.season3).should('not.exist');
  });

  it('submits an inclusive cross-season TVDB episode range', () => {
    patchMonsterTv((body) => {
      body.externalIds = {
        ...((body.externalIds as object) ?? {}),
        tvdbId: 999,
      };
      body.mediaInfo = undefined;
      body.episodeRequestsEnabled = true;
    });
    cy.intercept('GET', '/api/v1/tv/225634/episodes', {
      statusCode: 200,
      body: {
        tvdbSeriesId: 999,
        episodes: [
          {
            tvdbId: 101,
            seasonNumber: 1,
            episodeNumber: 1,
            title: 'Pilot',
          },
          {
            tvdbId: 102,
            seasonNumber: 1,
            episodeNumber: 2,
            title: 'Second',
          },
          {
            tvdbId: 201,
            seasonNumber: 2,
            episodeNumber: 1,
            title: 'Return',
          },
        ],
      },
    }).as('episodeCatalog');
    cy.intercept('POST', '/api/v1/request', (req) => {
      expect(req.body.episodeSelection).to.deep.equal({
        type: 'range',
        startEpisodeTvdbId: 102,
        endEpisodeTvdbId: 201,
      });
      expect(req.body.seasons).to.equal(undefined);
      req.reply({
        statusCode: 201,
        body: { media: { status: 2 } },
      });
    }).as('episodeRequest');

    cy.visit(ROUTES.monsterTvShow);
    cy.get('button[aria-label="Expand"]').click();
    cy.contains('Request Episodes…').click();
    cy.wait('@episodeCatalog');
    cy.get('[data-testid="episode-selection-episode-101"]').click();
    cy.contains('1 episode selected').should('be.visible');
    cy.contains('button', 'Request 1 Episode').should('be.enabled');
    cy.get('[data-testid="episode-selection-extend"]').click();
    cy.contains('Choose the last episode to include').should('be.visible');
    cy.get('[data-testid="episode-selection-season-2"]').click();
    cy.get('[data-testid="episode-selection-episode-201"]').click();
    cy.contains('3 episodes selected across 2 seasons').should('be.visible');
    cy.get('button[aria-label="Change selection"]').click();
    cy.get('[data-testid="episode-selection-season-1"]').click();
    cy.get('[data-testid="episode-selection-episode-102"]').click();
    cy.get('[data-testid="episode-selection-extend"]').click();
    cy.get('[data-testid="episode-selection-season-2"]').click();
    cy.get('[data-testid="episode-selection-episode-201"]').click();
    cy.contains('2 episodes selected across 2 seasons').should('be.visible');
    cy.contains('button', 'Request 2 Episodes').click();
    cy.wait('@episodeRequest');
  });

  it('submits an open-ended TVDB episode request', () => {
    patchMonsterTv((body) => {
      body.externalIds = {
        ...((body.externalIds as object) ?? {}),
        tvdbId: 999,
      };
      body.mediaInfo = undefined;
      body.episodeRequestsEnabled = true;
    });
    cy.intercept('GET', '/api/v1/tv/225634/episodes', {
      statusCode: 200,
      body: {
        tvdbSeriesId: 999,
        episodes: [
          {
            tvdbId: 101,
            seasonNumber: 1,
            episodeNumber: 1,
            title: 'Pilot',
          },
          {
            tvdbId: 102,
            seasonNumber: 1,
            episodeNumber: 2,
            title: 'Second',
          },
          {
            tvdbId: 201,
            seasonNumber: 2,
            episodeNumber: 1,
            title: 'Return',
          },
        ],
      },
    }).as('episodeCatalog');
    cy.intercept('POST', '/api/v1/request', (req) => {
      expect(req.body.episodeSelection).to.deep.equal({
        type: 'after',
        startEpisodeTvdbId: 102,
      });
      expect(req.body.seasons).to.equal(undefined);
      req.reply({
        statusCode: 201,
        body: { media: { status: 2 } },
      });
    }).as('ongoingEpisodeRequest');

    cy.visit(ROUTES.monsterTvShow);
    cy.get('button[aria-label="Expand"]').click();
    cy.contains('Request Episodes…').click();
    cy.wait('@episodeCatalog');
    cy.get('[data-testid="episode-selection-episode-102"]').click();
    cy.get('[data-testid="episode-selection-ongoing"]')
      .should('be.visible')
      .click();
    cy.contains(
      '2 available now across 2 seasons · new episodes included'
    ).should('be.visible');
    cy.contains('button', 'Request This & Future Episodes').click();
    cy.wait('@ongoingEpisodeRequest');
  });

  it('offers episode requests from discover cards', () => {
    cy.intercept('GET', '/api/v1/discover/tv*', {
      page: 1,
      totalPages: 1,
      totalResults: 1,
      results: [
        {
          id: 225634,
          mediaType: 'tv',
          name: 'Monster',
          originalName: 'Monster',
          overview: 'Unrequested series for episode-request UI.',
          firstAirDate: '2024-01-01',
          voteAverage: 8,
          voteCount: 10,
          popularity: 100,
          genreIds: [],
          originalLanguage: 'en',
          originCountry: ['US'],
        },
      ],
    }).as('getPopularTv');
    cy.visit(ROUTES.home);
    cy.wait('@getPopularTv');

    cy.contains('.slider-header', 'Popular Series')
      .next('[data-testid="media-slider"]')
      .find('[data-testid="title-card"]')
      .first()
      .as('discoverCard');

    cy.get('@discoverCard')
      .find('[data-testid="title-card-title"]')
      .should('contain', 'Monster');
    cy.get('@discoverCard')
      .find('button[aria-label="More request options"]')
      .should('be.visible')
      .click();
    cy.get('[data-testid="title-card-request-episodes"]').should('be.visible');
  });

  it('quick-requests one episode from the detail episode list', () => {
    patchMonsterTv((body) => {
      body.mediaInfo = undefined;
      body.episodeRequestsEnabled = true;
    });
    cy.intercept('GET', '/api/v1/tv/225634/season/1', episodeSeason).as(
      'season1'
    );
    cy.visit(ROUTES.monsterTvShow);
    cy.get('[data-testid="season-disclosure-1"]').scrollIntoView().click();

    cy.wait('@season1').then(({ response }) => {
      const episode = response?.body.episodes[0];
      expect(episode?.id).to.be.a('number');
      cy.intercept('POST', '/api/v1/request', (req) => {
        expect(req.body.episodeSelection).to.deep.equal({
          type: 'single',
          episodeTvdbId: episode.id,
        });
        req.reply({
          statusCode: 201,
          body: {
            id: 999,
            status: 2,
            episodes: [{ tvdbId: episode.id, status: 2 }],
            media: { status: 2 },
          },
        });
      }).as('singleEpisodeRequest');

      cy.get(`[data-testid="episode-quick-request-${episode.id}"]`).click();
      cy.wait('@singleEpisodeRequest');
      cy.get(`[data-testid="episode-request-status-${episode.id}"]`).should(
        'contain',
        'Requested'
      );
      cy.get(`[data-testid="episode-quick-request-${episode.id}"]`).should(
        'not.exist'
      );
    });
  });

  it('marks every episode requested when a season request follows episode requests', () => {
    const seasonWithThreeEpisodes = {
      ...episodeSeason,
      episodes: [
        episodeSeason.episodes[0],
        {
          ...episodeSeason.episodes[0],
          id: 102,
          name: 'Second',
          episodeNumber: 2,
        },
        {
          ...episodeSeason.episodes[0],
          id: 103,
          name: 'Third',
          episodeNumber: 3,
        },
      ],
    };
    patchMonsterTv((body) => {
      body.externalIds = {
        ...((body.externalIds as object) ?? {}),
        tvdbId: 999,
      };
      body.episodeRequestsEnabled = true;
      body.seasons = [
        ...(body.seasons as object[]),
        {
          ...(body.seasons as object[])[0],
          id: 2,
          name: 'Season 2',
          seasonNumber: 2,
        },
      ];
      body.mediaInfo = {
        ...(body.mediaInfo as object),
        status: 3,
        status4k: 1,
        issues: [],
        seasons: [],
        requests: [
          {
            id: 100,
            status: 2,
            is4k: false,
            createdAt: '2026-07-28T10:00:00.000Z',
            seasons: [],
            episodes: [
              {
                tvdbId: 101,
                seasonNumber: 1,
                episodeNumber: 1,
                status: 2,
              },
            ],
          },
          {
            id: 101,
            status: 2,
            is4k: false,
            createdAt: '2026-07-28T11:00:00.000Z',
            seasons: [{ seasonNumber: 1, status: 2 }],
            episodes: [],
          },
        ],
      };
    });
    cy.intercept(
      'GET',
      '/api/v1/tv/225634/season/1',
      seasonWithThreeEpisodes
    ).as('season1');
    cy.intercept('GET', '/api/v1/tv/225634/episodes', {
      tvdbSeriesId: 999,
      episodes: seasonWithThreeEpisodes.episodes.map((episode) => ({
        tvdbId: episode.id,
        seasonNumber: episode.seasonNumber,
        episodeNumber: episode.episodeNumber,
        title: episode.name,
        airDate: episode.airDate,
      })),
    }).as('episodeCatalog');

    cy.visit(ROUTES.monsterTvShow);
    cy.get('[data-testid="season-disclosure-1"]').scrollIntoView().click();
    cy.wait('@season1');

    [101, 102, 103].forEach((episodeId) => {
      cy.get(`[data-testid="episode-request-status-${episodeId}"]`).should(
        'contain',
        'Requested'
      );
      cy.get(`[data-testid="episode-quick-request-${episodeId}"]`).should(
        'not.exist'
      );
    });

    cy.get('button[aria-label="Expand"]').click();
    cy.contains('Request Episodes…').click();
    cy.wait('@episodeCatalog');
    [101, 102, 103].forEach((episodeId) => {
      cy.get(
        `[data-testid="episode-selection-request-status-${episodeId}"]`
      ).should('contain', 'Requested');
      cy.get(`[data-testid="episode-selection-episode-${episodeId}"]`).should(
        'be.disabled'
      );
    });
  });

  it('allows a full-season request after requesting some episodes', () => {
    patchMonsterTv((body) => {
      body.externalIds = {
        ...((body.externalIds as object) ?? {}),
        tvdbId: 999,
      };
      body.episodeRequestsEnabled = true;
      body.mediaInfo = {
        ...(body.mediaInfo as object),
        status: 3,
        status4k: 5,
        issues: [],
        seasons: [],
        requests: [
          {
            id: 100,
            status: 2,
            is4k: false,
            createdAt: '2026-07-28T10:00:00.000Z',
            seasons: [],
            episodes: [
              {
                tvdbId: 101,
                seasonNumber: 1,
                episodeNumber: 1,
                status: 2,
              },
            ],
          },
        ],
      };
    }, 'monsterTvShow');
    cy.intercept('POST', '/api/v1/request', (req) => {
      expect(req.body.seasons).to.deep.equal([1]);
      expect(req.body.episodeSelection).to.equal(undefined);
      req.reply({
        statusCode: 201,
        body: { media: { status: 3 } },
      });
    }).as('seasonRequest');

    cy.visit(ROUTES.monsterTvShow);
    cy.wait('@monsterTvShow');
    cy.contains('button', 'Request More').click();
    cy.get('[data-testid="season-request-toggle-1"]')
      .should('have.attr', 'aria-checked', 'false')
      .and('have.attr', 'aria-disabled', 'false')
      .click()
      .should('have.attr', 'aria-checked', 'true');
    cy.contains('button', 'Request 1 Season').click();
    cy.wait('@seasonRequest');
  });

  it('shows season progress and toggles an episode watched on Trakt', () => {
    cy.intercept('GET', '/api/v1/settings/public', (req) => {
      delete req.headers['if-none-match'];
      req.continue((res) => {
        const raw = res.body;
        const body =
          typeof raw === 'string' && raw
            ? JSON.parse(raw)
            : raw && typeof raw === 'object'
              ? raw
              : {};
        res.send({
          ...body,
          traktConfigured: true,
          mediaActionsTraktEnabled: true,
        });
      });
    });
    let watchedEpisodeNumbers: number[] = [];
    cy.intercept(
      'GET',
      '/api/v1/media-actions/tv/225634/seasons/1/episodes/status',
      (req) => {
        req.reply({ available: true, watchedEpisodeNumbers });
      }
    ).as('episodeWatchStatus');
    cy.intercept(
      'POST',
      '/api/v1/media-actions/tv/225634/seasons/1/episodes/*/watched',
      (req) => {
        watchedEpisodeNumbers = [1];
        req.reply({
          outcome: 'success',
          watched: true,
          providers: [
            {
              provider: 'trakt',
              ok: true,
              watched: true,
              rating: null,
              ratingStars: null,
            },
          ],
        });
      }
    ).as('markEpisodeWatched');
    cy.intercept('GET', '/api/v1/tv/225634/season/1', episodeSeason).as(
      'season1'
    );

    cy.visit(ROUTES.monsterTvShow);
    cy.wait('@mediaActionCapabilities');
    cy.wait('@episodeWatchStatus');
    cy.get('[data-testid="season-disclosure-1"]').should('contain', '0/');
    cy.get('[data-testid="season-disclosure-1"]').scrollIntoView().click();
    cy.wait('@season1');

    cy.get('button[aria-label="Mark watched"]').first().click();
    cy.wait('@markEpisodeWatched');
    cy.get('button[aria-label="Mark unwatched"]').should('exist');
  });
});
