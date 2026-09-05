import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isLoopbackAddress,
  isPluginMode,
  pluginCookiePath,
  pluginPublicBasePath,
  signPluginMint,
  verifyPluginMintSignature,
} from './pluginMode';

describe('pluginMode', () => {
  it('treats FORESEERR_PLUGIN=1 as plugin mode with /Foreseerr base', () => {
    const previousPlugin = process.env.FORESEERR_PLUGIN;
    const previousBase = process.env.FORESEERR_BASE_PATH;
    process.env.FORESEERR_PLUGIN = '1';
    delete process.env.FORESEERR_BASE_PATH;
    try {
      assert.equal(isPluginMode(), true);
      assert.equal(pluginPublicBasePath(), '/Foreseerr');
      assert.equal(pluginCookiePath(), '/Foreseerr');
    } finally {
      if (previousPlugin === undefined) delete process.env.FORESEERR_PLUGIN;
      else process.env.FORESEERR_PLUGIN = previousPlugin;
      if (previousBase === undefined) delete process.env.FORESEERR_BASE_PATH;
      else process.env.FORESEERR_BASE_PATH = previousBase;
    }
  });

  it('verifies HMAC mint signatures within skew', () => {
    const timestamp = 1_700_000_000;
    const signature = signPluginMint('secret', 'user-1', timestamp);
    assert.equal(
      verifyPluginMintSignature({
        secret: 'secret',
        jellyfinUserId: 'user-1',
        timestamp,
        signature,
        nowSeconds: timestamp,
      }),
      true
    );
    assert.equal(
      verifyPluginMintSignature({
        secret: 'secret',
        jellyfinUserId: 'user-1',
        timestamp,
        signature: 'deadbeef',
        nowSeconds: timestamp,
      }),
      false
    );
    assert.equal(
      verifyPluginMintSignature({
        secret: 'secret',
        jellyfinUserId: 'user-1',
        timestamp,
        signature,
        nowSeconds: timestamp + 121,
      }),
      false
    );
  });

  it('recognizes loopback addresses', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true);
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
    assert.equal(isLoopbackAddress('::1'), true);
    assert.equal(isLoopbackAddress('192.168.1.5'), false);
  });
});
