import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashPassword, verifyPassword } from './password';

describe('password hashing', () => {
  it('hashes with bcrypt cost 12 and verifies', async () => {
    const hash = await hashPassword('test1234');
    assert.match(hash, /^\$2[aby]\$12\$/);
    assert.equal(await verifyPassword('test1234', hash), true);
    assert.equal(await verifyPassword('wrong', hash), false);
  });

  it('verifies existing node-bcrypt hashes', async () => {
    const legacy =
      '$2b$12$Z5V2P5HZgmx4/AnWFMZN1.aD5AM1NucNi.mhNTSQ9oVtmdzu7Le/a';
    assert.equal(await verifyPassword('test1234', legacy), true);
    assert.equal(await verifyPassword('nope', legacy), false);
  });
});
