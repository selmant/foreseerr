import {
  setDesktopApplicationUrl,
  setDesktopRuntime,
} from '@server/lib/desktopState';
import Settings from '@server/lib/settings';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('desktop application URL', () => {
  it('uses the managed loopback origin without persisting its random port', () => {
    const settings = new Settings();
    settings.main.applicationUrl = 'https://persisted.example.test';

    try {
      setDesktopRuntime(true);
      setDesktopApplicationUrl('http://127.0.0.1:43127');

      assert.equal(settings.main.applicationUrl, 'http://127.0.0.1:43127');
      assert.equal(
        settings.fullPublicSettings.applicationUrl,
        'http://127.0.0.1:43127'
      );

      settings.main.applicationUrl = 'http://127.0.0.1:43127';
      settings.main.applicationUrl = 'http://127.0.0.1:43127/';

      // Settings updates commonly spread the currently visible main object.
      // That must not turn the effective URL into durable configuration.
      settings.main = { ...settings.main, applicationTitle: 'Standalone' };
    } finally {
      setDesktopRuntime(false);
    }

    assert.equal(
      settings.main.applicationUrl,
      'https://persisted.example.test'
    );
  });
});
