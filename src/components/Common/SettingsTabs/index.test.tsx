import { Permission } from '@app/hooks/useUser';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { MemoryRouter } from 'react-router';
import { SWRConfig } from 'swr';
import SettingsTabs, { type SettingsRoute } from './index';

const routes: SettingsRoute[] = [
  { text: 'General', route: '/settings/main', regex: /^\/settings\/main$/ },
  {
    text: 'Integrations',
    route: '/settings/integrations',
    regex: /^\/settings\/integrations$/,
  },
  {
    text: 'Permissions',
    route: '/settings/permissions',
    regex: /^\/settings\/permissions$/,
    requiredPermission: Permission.MANAGE_USERS,
  },
  {
    text: 'Hidden',
    route: '/settings/hidden',
    regex: /^\/settings\/hidden$/,
    hidden: true,
  },
];

const render = (
  path: string,
  permissions: number,
  tabType: 'default' | 'button' = 'default'
) =>
  renderToStaticMarkup(
    <SWRConfig
      value={{
        provider: () => new Map(),
        fallback: { '/api/v1/auth/me': { permissions } },
      }}
    >
      <IntlProvider locale="en">
        <MemoryRouter initialEntries={[path]}>
          <SettingsTabs tabType={tabType} settingsRoutes={routes} />
        </MemoryRouter>
      </IntlProvider>
    </SWRConfig>
  );

describe('Settings section navigation', () => {
  for (const tabType of ['default', 'button'] as const) {
    it(`applies permissions and hidden sections to both ${tabType} layouts`, () => {
      const markup = render('/settings/main', 0, tabType);
      assert.ok(markup.includes('Integrations'));
      assert.equal(markup.includes('Permissions'), false);
      assert.equal(markup.includes('Hidden'), false);
      assert.ok(
        render('/settings/main', Permission.MANAGE_USERS, tabType).includes(
          'Permissions'
        )
      );
    });
  }

  it('marks only the current link and selects the same mobile section', () => {
    const markup = render('/settings/integrations', Permission.ADMIN);
    assert.equal((markup.match(/aria-current="page"/g) ?? []).length, 1);
    assert.ok(
      /<option value="\/settings\/integrations" selected="">/.test(markup)
    );
    assert.ok(
      /href="\/settings\/integrations"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/settings\/integrations"/.test(
        markup
      )
    );
    const general = render('/settings/main', Permission.ADMIN);
    assert.ok(/<option value="\/settings\/main" selected="">/.test(general));
  });
});
