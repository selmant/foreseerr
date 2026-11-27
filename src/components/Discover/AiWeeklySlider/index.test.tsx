import AiWeeklySlider from '@app/components/Discover/AiWeeklySlider';
import { SettingsProvider } from '@app/context/SettingsContext';
import type { AiRun } from '@shared/interfaces/api/aiInterfaces';
import type { PublicSettingsResponse } from '@shared/interfaces/api/settingsInterfaces';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { MemoryRouter } from 'react-router';
import { SWRConfig } from 'swr';

const run: AiRun = {
  id: 42,
  stage: 'done',
  createdAt: '2026-11-23T00:00:00.000Z',
  request: {
    prompt: '',
    seed: null,
    only: null,
    anime: false,
    refinements: [],
  },
  source: 'server',
  model: null,
  origin: 'weekly',
  result: {
    headline: 'Slow-burn thrillers this week',
    summary: '',
    picks: [
      {
        mediaType: 'movie',
        tmdbId: 603,
        why: 'Fits your taste',
        source: 'tmdb',
        feedback: null,
        item: { id: 603, mediaType: 'movie', title: 'The Matrix' },
      },
    ],
    refinements: [],
    candidates: 1,
    usedWeb: false,
  },
  error: null,
};

const render = (
  weekly: { run: AiRun | null } | undefined,
  aiEnabled = true
) => {
  const fallback: Record<string, unknown> = {
    '/api/v1/auth/me': { id: 1, permissions: 2, userType: 3 },
  };
  if (weekly) {
    fallback['/api/v1/ai/weekly'] = weekly;
  }
  return renderToStaticMarkup(
    <SWRConfig value={{ provider: () => new Map(), fallback }}>
      <SettingsProvider
        currentSettings={
          { aiEnabled, hideAvailable: false } as PublicSettingsResponse
        }
      >
        <IntlProvider locale="en">
          <MemoryRouter>
            <AiWeeklySlider title="This week for you" />
          </MemoryRouter>
        </IntlProvider>
      </SettingsProvider>
    </SWRConfig>
  );
};

describe('AiWeeklySlider', () => {
  it('shows the weekly picks, linking to the run', () => {
    const markup = render({ run });
    assert.ok(markup.includes('This week for you'));
    assert.ok(markup.includes('/discover/ai?run=42'));
    assert.ok(markup.includes('Slow-burn thrillers this week'));
  });

  it('holds a placeholder row while loading', () => {
    const markup = render(undefined);
    assert.ok(markup.includes('This week for you'));
    assert.ok(markup.includes('href="/discover/ai"'));
  });

  it('hides when there is no weekly run', () => {
    assert.equal(render({ run: null }), '');
  });

  it('hides when AI is off', () => {
    assert.equal(render({ run }, false), '');
  });
});
