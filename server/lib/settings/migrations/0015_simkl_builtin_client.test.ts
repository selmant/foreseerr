import migrateSimklBuiltinClient from '@server/lib/settings/migrations/0015_simkl_builtin_client';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('0015_simkl_builtin_client', () => {
  it('keeps Simkl on for an install with its own Client ID', () => {
    const migrated = migrateSimklBuiltinClient({
      simkl: {
        clientId: 'own-client',
        showCommunityRating: true,
        posterCommunityRating: false,
      },
      migrations: [],
    });
    assert.equal(migrated.simkl.enabled, true);
    assert.equal(migrated.simkl.clientId, 'own-client');
    assert.ok(migrated.migrations.includes('0015_simkl_builtin_client'));
  });

  it('leaves Simkl off for an install that never set it up', () => {
    assert.equal(
      migrateSimklBuiltinClient({ simkl: { clientId: '  ' }, migrations: [] })
        .simkl.enabled,
      false
    );
    assert.equal(
      migrateSimklBuiltinClient({ migrations: [] }).simkl.enabled,
      false
    );
  });

  it('keeps a choice already made, and is idempotent', () => {
    const once = migrateSimklBuiltinClient({
      simkl: { clientId: '', enabled: true },
      migrations: [],
    });
    assert.equal(once.simkl.enabled, true);
    const twice = migrateSimklBuiltinClient(once);
    assert.equal(
      twice.migrations.filter((name) => name === '0015_simkl_builtin_client')
        .length,
      1
    );
  });
});
