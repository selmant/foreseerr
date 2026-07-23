import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mediaActionWriteSucceeded } from './clientWriteGate';

describe('mediaActionWriteSucceeded', () => {
  it('rejects failure outcome', () => {
    assert.equal(
      mediaActionWriteSucceeded({
        outcome: 'failure',
        providers: [{ ok: false }],
      }),
      false
    );
  });

  it('rejects empty providers', () => {
    assert.equal(mediaActionWriteSucceeded({ providers: [] }), false);
  });

  it('accepts all-ok success', () => {
    assert.equal(
      mediaActionWriteSucceeded({
        outcome: 'success',
        providers: [{ ok: true }],
      }),
      true
    );
  });

  it('accepts partial when at least one provider ok', () => {
    assert.equal(
      mediaActionWriteSucceeded({
        outcome: 'partial',
        providers: [{ ok: true }, { ok: false }],
      }),
      true
    );
  });

  it('rejects when every provider ok is false', () => {
    assert.equal(
      mediaActionWriteSucceeded({
        providers: [{ ok: false }],
      }),
      false
    );
  });
});
