import type { AiMe } from '@shared/interfaces/api/aiInterfaces';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { HelmetProvider } from 'react-helmet-async';
import { IntlProvider } from 'react-intl';
import { MemoryRouter, Route, Routes } from 'react-router';
import { SWRConfig } from 'swr';
import UserDiscoverSettings from './UserDiscoverSettings';
import UserLinkedAccountsSettings from './UserLinkedAccountsSettings';

const me: AiMe = {
  enabled: true,
  policy: { allowChatgpt: true, allowEndpoints: false, allowModelChoice: true },
  server: null,
  own: {
    kind: 'chatgpt',
    status: 'ok',
    model: 'gpt-6-luna',
    lastError: null,
    updatedAt: null,
    lastUsedAt: null,
    accountEmail: 'personal@example.test',
  },
  usage: { usedToday: 0, dailyLimit: null },
  preferences: {
    useOwnConnection: true,
    model: null,
    useHistory: false,
    historyConsentAt: null,
  },
  effective: {
    available: true,
    source: 'own',
    kind: 'chatgpt',
    model: 'gpt-6-luna',
    preset: null,
    accountEmail: 'personal@example.test',
    usesChatgptPlan: true,
    manageUsageUrl: null,
  },
  chatgptRedirectUri: 'http://localhost:1455/auth/callback',
};

const renderSettings = (
  page: 'linked-accounts' | 'discover',
  otherUser = false
) => {
  const ownUser = { id: 1, displayName: 'Admin', permissions: 2, userType: 3 };
  const targetUser = {
    id: 2,
    displayName: 'Other user',
    permissions: 0,
    userType: 3,
  };
  const pageElement =
    page === 'linked-accounts' ? (
      <UserLinkedAccountsSettings />
    ) : (
      <UserDiscoverSettings />
    );
  return renderToStaticMarkup(
    <HelmetProvider>
      <SWRConfig
        value={{
          provider: () => new Map(),
          fallback: {
            '/api/v1/auth/me': ownUser,
            '/api/v1/user/2': targetUser,
            '/api/v1/user/1/settings/discover': {},
            '/api/v1/user/2/settings/discover': {},
            '/api/v1/ai/me': me,
            '/api/v1/ai/taste': {
              card: 'Private taste card',
              updatedAt: null,
              feedbackCount: 0,
              pendingFeedback: 0,
            },
            '/api/v1/ai/feedback': [],
          },
        }}
      >
        <IntlProvider locale="en">
          <MemoryRouter
            initialEntries={[
              `${otherUser ? '/users/2' : '/profile'}/settings/${page}`,
            ]}
          >
            <Routes>
              <Route path="/profile/settings/*" element={pageElement} />
              <Route path="/users/:userId/settings/*" element={pageElement} />
            </Routes>
          </MemoryRouter>
        </IntlProvider>
      </SWRConfig>
    </HelmetProvider>
  );
};

describe('Personal AI settings placement', () => {
  it('shows the linked account and model without exposing the connection form', () => {
    const markup = renderSettings('linked-accounts');
    assert.ok(markup.includes('personal@example.test'));
    assert.ok(markup.includes('gpt-6-luna'));
    assert.ok(markup.includes('aria-expanded="false"'));
    assert.equal(markup.includes('id="own-model"'), false);
    assert.equal(markup.includes('ai-history'), false);
  });

  it('keeps taste and history preferences in Discover', () => {
    const markup = renderSettings('discover');
    assert.ok(markup.includes('id="ai-preferences"'));
    assert.ok(markup.includes('id="ai-history"'));
    assert.ok(markup.includes('Private taste card'));
    assert.ok(markup.includes('/profile/settings/linked-accounts#ai-account'));
  });

  it('does not expose the signed-in user’s AI account or taste on another profile', () => {
    for (const page of ['linked-accounts', 'discover'] as const) {
      const markup = renderSettings(page, true);
      assert.equal(markup.includes('personal@example.test'), false);
      assert.equal(markup.includes('Private taste card'), false);
      assert.equal(markup.includes('id="ai-account"'), false);
      assert.equal(markup.includes('id="ai-preferences"'), false);
    }
  });
});
