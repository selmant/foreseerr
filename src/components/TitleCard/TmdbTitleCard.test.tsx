import { MediaStatus } from '@shared/constants/media';
import type { WatchlistItem } from '@shared/interfaces/api/discoverInterfaces';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { MemoryRouter } from 'react-router';
import type { Middleware } from 'swr';
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

const anilistTile: WatchlistItem = {
  id: 1429,
  ratingKey: 'anilist-16498',
  tmdbId: 1429,
  mediaType: 'tv',
  title: 'Shingeki no Kyojin',
  source: 'anilist',
  sourceId: '16498',
  posterPath: '/hTP1DtLGFamjfu8WqjnuQdP1n4i.jpg',
  firstAirDate: '2013-04-07',
};

const anilistMovieTile: WatchlistItem = {
  id: 372058,
  ratingKey: 'anilist-21519',
  tmdbId: 372058,
  mediaType: 'movie',
  title: 'Kimi no Na wa.',
  source: 'anilist',
  sourceId: '21519',
  posterPath: '/q719jXXEzOoYaps6babgKnONONX.jpg',
  releaseDate: '2016-08-26',
};

/** Details the card would show if it had subscribed to `/api/v1/{movie,tv}/:id`. */
const cachedDetails = {
  '/api/v1/tv/1396': {
    id: 1396,
    name: 'Details Title',
    overview: 'Details overview',
    voteAverage: 9.1,
    posterPath: '/details.jpg',
    firstAirDate: '1999-01-01',
  },
  '/api/v1/tv/1429': {
    id: 1429,
    name: 'Attack on Titan',
    overview: 'Titan overview',
    voteAverage: 8.6,
    posterPath: '/details.jpg',
    firstAirDate: '2013-04-07',
  },
  '/api/v1/movie/372058': {
    id: 372058,
    title: 'Your Name.',
    overview: 'Comet overview',
    voteAverage: 8.5,
    posterPath: '/details.jpg',
    releaseDate: '2016-08-26',
  },
};

/**
 * Stands in for an opened card: hover, focus, or tap only enables the details
 * key after the intent delay, so this enables it on first render instead.
 */
const detailsOpened =
  (detailsKey: string): Middleware =>
  (useSWRNext) =>
  (key, fetcher, config) =>
    useSWRNext(key ?? detailsKey, fetcher, config);

const render = (
  item: WatchlistItem,
  { opened = false }: { opened?: boolean } = {}
) =>
  renderToStaticMarkup(
    <SWRConfig
      value={{
        provider: () => new Map(),
        fallback: {
          '/api/v1/auth/me': { id: 1, permissions: 0 },
          ...cachedDetails,
        },
        use: opened
          ? [detailsOpened(`/api/v1/${item.mediaType}/${item.tmdbId}`)]
          : [],
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

  it('paints a row without a score before its details load fills it', () => {
    // Such a row is observed and loads its details as it scrolls into view,
    // not on hover; the tile itself is on screen from the first paint.
    const markup = render(traktTile);

    assert.ok(markup.includes('data-testid="title-card"'));
    assert.equal(markup.includes('data-testid="rating-badges"'), false);
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

describe('Mapped provider title cards after details load', () => {
  for (const [name, item, providerTitle, tmdbTitle, detailsScore] of [
    [
      'AniList series',
      anilistTile,
      'Shingeki no Kyojin',
      'Attack on Titan',
      '>86%<',
    ],
    [
      'AniList movie',
      anilistMovieTile,
      'Kimi no Na wa.',
      'Your Name.',
      '>85%<',
    ],
    ['Trakt series', traktTile, 'Breaking Bad', 'Details Title', '>91%<'],
  ] as const) {
    it(`keeps the provider title on a mapped ${name}`, () => {
      const closed = render(item);
      const opened = render(item, { opened: true });

      assert.ok(closed.includes(providerTitle));
      assert.equal(closed.includes(tmdbTitle), false);
      // Details did arrive: the score is TMDB's, the label is not.
      assert.equal(closed.includes(detailsScore), false);
      assert.ok(opened.includes(detailsScore));
      assert.ok(opened.includes(providerTitle));
      assert.equal(opened.includes(tmdbTitle), false);
    });
  }

  it('keeps the row title when cached details are present on remount', () => {
    // A second render with the same cache contents is a remounted card.
    const first = render(anilistTile, { opened: true });
    const second = render(anilistTile, { opened: true });

    assert.equal(first, second);
    assert.equal(second.includes('Attack on Titan'), false);
  });

  it('keeps the provider title on unmapped cards', () => {
    const markup = render(
      { ...anilistTile, tmdbId: undefined, posterPath: undefined },
      { opened: true }
    );

    assert.ok(markup.includes('data-testid="unmapped-title-card"'));
    assert.ok(markup.includes('Shingeki no Kyojin'));
    assert.equal(markup.includes('Attack on Titan'), false);
  });
});
