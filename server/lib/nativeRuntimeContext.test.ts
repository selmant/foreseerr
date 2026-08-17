import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const source = readFileSync(
  join(__dirname, '../../src/context/NativeRuntimeContext.tsx'),
  'utf8'
);

describe('NativeRuntimeContext play admission', () => {
  it('does not admit play.item while native auth is degraded', () => {
    assert.match(
      source,
      /export const canAdmitNativePlay = \(state: NativeRuntimeState\): boolean =>\s+state === 'ready' \|\| state === 'playing';/
    );
    assert.match(
      source,
      /if \(canAdmitNativePlay\(state\)\) \{\s+return admitPlay\(target\);/
    );
    assert.doesNotMatch(
      source,
      /state === 'ready' \|\| state === 'playing' \|\| state === 'degraded'/
    );
  });

  it('clears the native session on user switch even without session-reset', () => {
    assert.match(
      source,
      /isUsableForeseerNative\(host\)\s+\) \{\s+host\.send\(\{ type: 'session\.clear'/
    );
    assert.doesNotMatch(source, /capabilities\.includes\('session-reset'\)/);
  });

  it('does not treat a play terminal event as recovered auth', () => {
    assert.match(source, /current === 'playing' \? 'ready' : current/);
    assert.doesNotMatch(
      source,
      /current === 'playing' \|\| current === 'degraded'/
    );
  });
});
