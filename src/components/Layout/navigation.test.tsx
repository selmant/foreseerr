import { Permission } from '@app/hooks/useUser';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { SWRConfig } from 'swr';
import { useAppNavigation } from './navigation';

const navigationFor = (permissions: number) => {
  let links: ReturnType<typeof useAppNavigation> = [];
  const Probe = () => {
    links = useAppNavigation({
      pendingRequestsCount: 2,
      openIssuesCount: 3,
      activeInterventionsCount: 4,
    });
    return null;
  };
  renderToStaticMarkup(
    <SWRConfig
      value={{
        provider: () => new Map(),
        fallback: { '/api/v1/auth/me': { permissions } },
      }}
    >
      <MemoryRouter>
        <Probe />
      </MemoryRouter>
    </SWRConfig>
  );
  return links;
};

describe('Shared application navigation', () => {
  it('makes personal features available without administration permissions', () => {
    const links = navigationFor(0);
    assert.deepEqual(
      links.filter((link) => link.group === 'explore').map((link) => link.href),
      ['/', '/library', '/requests', '/calendar']
    );
    assert.deepEqual(
      links.filter((link) => link.group === 'account').map((link) => link.href),
      [
        '/profile/watchlist',
        '/profile/settings/linked-accounts',
        '/profile/settings/discover',
      ]
    );
    assert.equal(
      links.some((link) => link.group === 'manage'),
      false
    );
    assert.equal(
      links.some((link) => link.count > 0),
      false
    );
  });

  it('gives request managers queue access without exposing admin settings', () => {
    const links = navigationFor(Permission.MANAGE_REQUESTS);
    assert.equal(
      links.find((link) => link.href === '/interventions')?.count,
      4
    );
    assert.equal(links.find((link) => link.href === '/requests')?.count, 2);
    assert.equal(
      links.some((link) => link.href === '/settings'),
      false
    );
    assert.equal(
      links.some((link) => link.href === '/users'),
      false
    );
  });

  it('includes all management destinations and attention counts for admins', () => {
    const links = navigationFor(Permission.ADMIN);
    assert.deepEqual(
      links.filter((link) => link.group === 'manage').map((link) => link.href),
      ['/interventions', '/blocklist', '/issues', '/users', '/settings']
    );
    assert.deepEqual(
      links
        .filter((link) => link.count > 0)
        .map((link) => [link.href, link.count]),
      [
        ['/requests', 2],
        ['/interventions', 4],
        ['/issues', 3],
      ]
    );
  });
});
