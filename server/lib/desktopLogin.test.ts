import {
  forgetDesktopUser,
  recalledDesktopUserId,
  rememberDesktopUser,
  resetDesktopLoginCacheForTests,
  restoreDesktopSession,
} from '@server/lib/desktopLogin';
import { setDesktopRuntime } from '@server/lib/desktopState';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import session from 'express-session';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import request from 'supertest';

setupTestDb();

const withTempConfig = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'foreseer-desktop-login-'));
  process.env.CONFIG_DIRECTORY = directory;
  resetDesktopLoginCacheForTests();
  return directory;
};

afterEach(() => {
  setDesktopRuntime(false);
  resetDesktopLoginCacheForTests();
  delete process.env.CONFIG_DIRECTORY;
});

describe('desktop login persistence', () => {
  it('does not remember users outside the desktop runtime', () => {
    const directory = withTempConfig();
    rememberDesktopUser(1);
    assert.equal(recalledDesktopUserId(), undefined);
    assert.throws(() =>
      readFileSync(join(directory, 'state', 'desktop-login.json'))
    );
  });

  it('round-trips the remembered user across a cache reset', () => {
    const directory = withTempConfig();
    setDesktopRuntime(true);
    rememberDesktopUser(1);
    assert.equal(
      JSON.parse(
        readFileSync(join(directory, 'state', 'desktop-login.json'), 'utf8')
      ).userId,
      1
    );

    resetDesktopLoginCacheForTests();
    assert.equal(recalledDesktopUserId(), 1);
  });

  it('forgets the remembered user', () => {
    const directory = withTempConfig();
    setDesktopRuntime(true);
    rememberDesktopUser(1);
    forgetDesktopUser();
    resetDesktopLoginCacheForTests();
    assert.equal(recalledDesktopUserId(), undefined);
    assert.throws(() =>
      readFileSync(join(directory, 'state', 'desktop-login.json'))
    );
  });

  it('restores a session without a cookie on a fresh MemoryStore', async () => {
    withTempConfig();
    setDesktopRuntime(true);
    rememberDesktopUser(1);

    const app = express();
    app.use(
      session({
        secret: 'test-secret',
        resave: false,
        saveUninitialized: false,
        store: new session.MemoryStore(),
      })
    );
    app.use(restoreDesktopSession);
    app.get('/who', (req, res) => {
      res.json({ userId: req.session.userId ?? null });
    });

    const restored = await request(app).get('/who');
    assert.equal(restored.status, 200);
    assert.equal(restored.body.userId, 1);
    const cookies = restored.headers['set-cookie'];
    assert.match(
      (Array.isArray(cookies) ? cookies.join(';') : cookies) ?? '',
      /connect\.sid/
    );
  });

  it('does not restore a missing user and clears the file', async () => {
    withTempConfig();
    setDesktopRuntime(true);
    rememberDesktopUser(99999);

    const app = express();
    app.use(
      session({
        secret: 'test-secret',
        resave: false,
        saveUninitialized: false,
        store: new session.MemoryStore(),
      })
    );
    app.use(restoreDesktopSession);
    app.get('/who', (req, res) => {
      res.json({ userId: req.session.userId ?? null });
    });

    const restored = await request(app).get('/who');
    assert.equal(restored.status, 200);
    assert.equal(restored.body.userId, null);
    resetDesktopLoginCacheForTests();
    assert.equal(recalledDesktopUserId(), undefined);
  });
});
