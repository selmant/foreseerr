import type { PublicSettingsResponse } from '@server/interfaces/api/settingsInterfaces';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { verifyAndResubscribePushSubscription } from './pushSubscriptionHelpers';

const settings = {
  enablePushRegistration: true,
  vapidPublic: 'dGVzdA',
} as PublicSettingsResponse;

describe('verifyAndResubscribePushSubscription', () => {
  const originalNavigator = globalThis.navigator;

  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: originalNavigator,
    });
  });

  it('returns false when the runtime has no service worker', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {},
    });

    assert.equal(
      await verifyAndResubscribePushSubscription(1, settings),
      false
    );
  });
});
