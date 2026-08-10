import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hasServarrMapping } from './servarrMapping';

describe('hasServarrMapping', () => {
  it('accepts a complete standard mapping', () => {
    assert.equal(
      hasServarrMapping({ serviceId: 1, externalServiceId: 101 }),
      true
    );
  });

  it('accepts a complete 4K mapping', () => {
    assert.equal(
      hasServarrMapping({ serviceId4k: 2, externalServiceId4k: 202 }),
      true
    );
  });

  it('rejects incomplete and missing mappings', () => {
    assert.equal(hasServarrMapping({ serviceId: 1 }), false);
    assert.equal(hasServarrMapping({ externalServiceId: 101 }), false);
    assert.equal(hasServarrMapping(undefined), false);
  });
});
