import { SettingsContext } from '@app/context/SettingsContext';
import type { WatchlistItem } from '@shared/interfaces/api/discoverInterfaces';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { useContext, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { MemoryRouter } from 'react-router';
import { SWRConfig } from 'swr';
import DiscoverProviderSlider from './DiscoverProviderSlider';
import MdblistListSlider from './MdblistListSlider';

const items: WatchlistItem[] = Array.from({ length: 25 }, (_, id) => ({
  id: id + 1,
  tmdbId: id + 1,
  ratingKey: `movie-${id}`,
  title: `Title${id}`,
  mediaType: 'movie',
  releaseDate: `${2000 + id}-01-01`,
  posterPath: '/poster.jpg',
  voteAverage: 7,
}));

const render = (endpoint: string, child: ReactNode) => {
  const Harness = () => {
    const settings = useContext(SettingsContext);
    return (
      <SettingsContext.Provider
        value={{
          currentSettings: {
            ...settings.currentSettings,
            mdblistConfigured: true,
          },
        }}
      >
        {child}
      </SettingsContext.Provider>
    );
  };
  return renderToStaticMarkup(
    <IntlProvider locale="en">
      <MemoryRouter>
        <SWRConfig
          value={{
            provider: () => new Map(),
            fallback: {
              [endpoint]: { page: 1, hasMore: false, results: items },
            },
            isPaused: () => true,
          }}
        >
          <Harness />
        </SWRConfig>
      </MemoryRouter>
    </IntlProvider>
  );
};

describe('provider slider ordering', () => {
  it('shows the newest 20 MDBList titles while retaining the complete source list', () => {
    const markup = render(
      '/api/v1/discover/mdblist/list?url=fixture',
      <MdblistListSlider
        title="Movies"
        url="fixture"
        sort="release_date.desc"
        sliderKey="movies"
      />
    );
    assert.match(markup, /aria-label="Title24, 2024"/);
    assert.match(markup, /aria-label="Title5, 2005"/);
    assert.doesNotMatch(markup, /aria-label="Title4, 2004"/);
    assert.ok(
      markup.indexOf('aria-label="Title24, 2024"') <
        markup.indexOf('aria-label="Title23, 2023"')
    );
    assert.equal(items[0].title, 'Title0');
  });
  it('preserves source ranking on an MDBList row without an explicit sort', () => {
    const markup = render(
      '/api/v1/discover/mdblist/list?url=fixture',
      <MdblistListSlider title="Curated" url="fixture" sliderKey="curated" />
    );
    assert.ok(
      markup.indexOf('aria-label="Title0, 2000"') <
        markup.indexOf('aria-label="Title1, 2001"')
    );
  });
  it('preserves source order and existing item counts for other provider rows', () => {
    const markup = render(
      '/fixture/provider',
      <DiscoverProviderSlider
        source="trakt"
        configured
        title="Other provider"
        endpoint="/fixture/provider"
        linkUrl="/fixture"
        sliderKey="other"
        emptyMessage="Empty"
      />
    );
    assert.ok(
      markup.indexOf('aria-label="Title0, 2000"') <
        markup.indexOf('aria-label="Title1, 2001"')
    );
    assert.match(markup, /aria-label="Title24, 2024"/);
  });
});
