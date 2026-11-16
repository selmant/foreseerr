import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { MemoryRouter } from 'react-router';
import MdblistBrowseControls from './MdblistBrowseControls';
import ReleaseDateFilter from './ReleaseDateFilter';

const render = (content: React.ReactNode) =>
  renderToStaticMarkup(
    <IntlProvider locale="en">
      <MemoryRouter>{content}</MemoryRouter>
    </IntlProvider>
  );

describe('native custom-list filter controls', () => {
  it('uses the Discover sort/filter toolbar and offers configurable ordering, with actual popularity and rating choices', () => {
    const markup = render(
      <MdblistBrowseControls
        type="movie"
        currentFilters={{ sortBy: 'release_date.desc' }}
      />
    );
    assert.match(markup, /rounded-r-only/);
    assert.match(markup, /value="release_date.desc" selected=""/);
    assert.match(markup, /Popularity Descending/);
    assert.match(markup, /TMDB Rating Descending/);
    assert.match(markup, /Source List Order/);
    assert.match(markup, /aria-haspopup="dialog"/);
  });
  it('preserves source order for existing rows without a saved sort', () => {
    assert.match(
      render(<MdblistBrowseControls type="movie" currentFilters={{}} />),
      /value="source" selected=""/
    );
  });
  it('uses first-air-date semantics for TV and counts both date bounds', () => {
    const markup = render(
      <MdblistBrowseControls
        type="tv"
        currentFilters={{
          firstAirDateGte: '2025-01-01',
          firstAirDateLte: '2025-12-31',
        }}
      />
    );
    assert.match(markup, /First Air Date Descending/);
    assert.match(markup, /2 Active Filters/);
  });
  it('reuses the native date picker with labels wired to input IDs', () => {
    const markup = render(
      <ReleaseDateFilter
        type="tv"
        currentFilters={{}}
        onChange={() => undefined}
      />
    );
    assert.match(markup, /First Air Date/);
    assert.match(markup, /name="fromdate"/);
    assert.match(markup, /name="todate"/);
    const label = markup.match(/for="([^"]+-fromdate)"/);
    assert.ok(label);
    assert.ok(markup.includes(`id="${label[1]}"`));
  });
});
