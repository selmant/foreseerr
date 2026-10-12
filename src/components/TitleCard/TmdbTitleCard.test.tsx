import { MediaStatus } from '@server/constants/media';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { MemoryRouter } from 'react-router';
import { SWRConfig } from 'swr';
import TmdbTitleCard, { watchlistTitleCardProps } from './TmdbTitleCard';

const traktTile: WatchlistItem = {
  id: 1396,
  ratingKey: 'trakt-show-1388',
  tmdbId: 1396,
  mediaType: 'tv',
  title: 'Breaking Bad',
  source: 'trakt',
  sourceId: '1388',
  posterPath: '/ggFHVNu6YYI5L9pCfOacjizRGt.jpg',
  firstAirDate: '2008-01-20',
  mediaInfo: {
    id: 7,
    tmdbId: 1396,
    status: MediaStatus.AVAILABLE,
    status4k: MediaStatus.UNKNOWN,
  },
};

/** Details the card would show if it had subscribed to `/api/v1/tv/:id`. */
const cachedDetails = {
  '/api/v1/tv/1396': {
    id: 1396,
    name: 'Details Title',
    overview: 'Details overview',
    posterPath: '/details.jpg',
    firstAirDate: '1999-01-01',
  },
};

const render = (item: WatchlistItem) =>
  renderToStaticMarkup(
    <SWRConfig
      value={{
        provider: () => new Map(),
        fallback: {
          '/api/v1/auth/me': { id: 1, permissions: 0 },
          ...cachedDetails,
        },
      }}
    >
      <IntlProvider locale="en">
        <MemoryRouter>
          <TmdbTitleCard {...watchlistTitleCardProps(item)} />
        </MemoryRouter>
      </IntlProvider>
    </SWRConfig>
  );

describe('Provider row title cards', () => {
  it('paint from the row payload without loading the title details', () => {
    const markup = render(traktTile);

    assert.ok(markup.includes('data-testid="title-card"'));
    assert.ok(
      markup.includes(
        'https://image.tmdb.org/t/p/w300_and_h450_face/ggFHVNu6YYI5L9pCfOacjizRGt.jpg'
      )
    );
    assert.ok(markup.includes('Breaking Bad, 2008'));
    // Status badge from the row's mediaInfo.
    assert.ok(markup.includes('bg-green-500/80'));
    assert.equal(markup.includes('Details'), false);
    assert.equal(markup.includes('/details.jpg'), false);
  });

  it('shows the TMDB score from the row on first paint', () => {
    const markup = render({ ...traktTile, voteAverage: 8.9 });

    assert.ok(markup.includes('data-testid="rating-badges"'));
    assert.ok(markup.includes('>89%<'));
  });

  it('leaves the TMDB score to the details load when the row has none', () => {
    assert.equal(
      render(traktTile).includes('data-testid="rating-badges"'),
      false
    );
  });

  it('keeps the placeholder and lazy details load for rows without a TMDB poster', () => {
    const markup = render({ ...traktTile, posterPath: undefined });

    assert.equal(markup.includes('data-testid="title-card"'), false);
    assert.equal(markup.includes('Breaking Bad'), false);
  });

  it('keeps the placeholder for rows whose media type is unknown', () => {
    const markup = render({ ...traktTile, mediaType: undefined });

    assert.equal(markup.includes('data-testid="title-card"'), false);
  });
});
