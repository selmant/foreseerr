import { SettingsContext } from '@app/context/SettingsContext';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { useContext } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { MemoryRouter } from 'react-router';
import DiscoverNavigation from './index';

const renderNavigation = (path: string, aiEnabled: boolean) => {
  const Harness = () => {
    const settings = useContext(SettingsContext);
    return (
      <SettingsContext.Provider
        value={{ currentSettings: { ...settings.currentSettings, aiEnabled } }}
      >
        <DiscoverNavigation />
      </SettingsContext.Provider>
    );
  };
  return renderToStaticMarkup(
    <IntlProvider locale="en">
      <MemoryRouter initialEntries={[path]}>
        <Harness />
      </MemoryRouter>
    </IntlProvider>
  );
};

describe('AI Picks within Discover navigation', () => {
  it('exposes AI Picks only when enabled and selects its tab for a saved run', () => {
    const markup = renderNavigation('/discover/ai?run=4', true);
    const links = [...markup.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
    assert.equal(links.length, 5);
    assert.ok(
      links
        .find((link) => link.includes('href="/discover/ai"'))
        ?.includes('aria-current="page"')
    );
    assert.equal(
      links.filter((link) => link.includes('aria-current="page"')).length,
      1
    );
    assert.equal(
      renderNavigation('/', false).includes('href="/discover/ai"'),
      false
    );
  });

  it('keeps Sources selected on tracker pages alongside the AI tab', () => {
    const markup = renderNavigation('/discover/trakt/watchlist', true);
    const sources = [...markup.matchAll(/<a\b[^>]*>/g)]
      .map((m) => m[0])
      .find((link) => link.includes('href="/discover/sources"'));
    assert.ok(sources?.includes('aria-current="page"'));
  });
});
