import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  discoverSources,
  getDiscoverSource,
  isSourceViewActive,
  sourceViewHref,
} from './sourceCatalog';

describe('Discover source navigation', () => {
  it('preserves Simkl content choices without carrying the previous watch status or page', () => {
    assert.equal(
      sourceViewHref(
        '/discover/simkl?status=completed',
        '?status=watching&mediaType=anime&page=4&period=month'
      ),
      '/discover/simkl?status=completed&mediaType=anime'
    );
    assert.equal(
      sourceViewHref(
        '/discover/simkl?view=trending',
        '?status=watching&mediaType=tv&period=day'
      ),
      '/discover/simkl?view=trending&mediaType=tv&period=day'
    );
    assert.equal(
      sourceViewHref(
        '/discover/simkl?status=hold',
        '?mediaType=invalid&period=invalid'
      ),
      '/discover/simkl?status=hold'
    );
    assert.equal(
      sourceViewHref('/discover/trakt/history', '?type=tv&mediaType=anime'),
      '/discover/trakt/history'
    );
  });
  it('links every source view to an existing page', () => {
    for (const source of discoverSources) {
      for (const view of source.views) {
        const path = view.href.split('?')[0].replace(/^\//, '');
        assert.ok(
          existsSync(join(process.cwd(), 'src/pages', `${path}.tsx`)),
          view.href
        );
        assert.equal(getDiscoverSource(`/${path}`)?.id, source.id);
      }
    }
  });

  it('recognizes provider pages without confusing other Discover pages', () => {
    assert.equal(getDiscoverSource('/discover/trakt/list')?.id, 'trakt');
    assert.equal(
      getDiscoverSource('/discover/anilist/next-season')?.id,
      'anilist'
    );
    assert.equal(getDiscoverSource('/discover/sources'), undefined);
    assert.equal(getDiscoverSource('/discover/trakt-other'), undefined);
    assert.equal(getDiscoverSource('/discover/movies'), undefined);
  });

  it('uses the default Simkl status and ignores unrelated filters', () => {
    assert.ok(
      isSourceViewActive(
        '/discover/simkl?status=plantowatch',
        '/discover/simkl',
        ''
      )
    );
    assert.ok(
      isSourceViewActive(
        '/discover/simkl?status=watching',
        '/discover/simkl',
        '?type=anime&status=watching'
      )
    );
    assert.equal(
      isSourceViewActive(
        '/discover/simkl?status=completed',
        '/discover/simkl',
        '?status=watching'
      ),
      false
    );
  });

  it('selects only Trending when Simkl view takes precedence over status', () => {
    const active = discoverSources
      .find((source) => source.id === 'simkl')!
      .views.filter((view) =>
        isSourceViewActive(
          view.href,
          '/discover/simkl',
          '?view=trending&status=watching'
        )
      );
    assert.deepEqual(
      active.map((view) => view.label),
      ['trending']
    );
  });

  it('keeps list detail pages distinct from the lists overview', () => {
    assert.equal(
      isSourceViewActive(
        '/discover/trakt/lists',
        '/discover/trakt/list',
        '?url=me/favorites'
      ),
      false
    );
    assert.ok(
      isSourceViewActive(
        '/discover/trakt/history',
        '/discover/trakt/history',
        '?hideWatched=true'
      )
    );
  });
});
