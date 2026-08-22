import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { jsonSafeClone } from './jsonSafe';

describe('jsonSafeClone', () => {
  it('clones plain data and ISO-stringifies dates', () => {
    const when = new Date('2026-08-22T18:00:00.000Z');
    assert.deepEqual(jsonSafeClone({ id: 1, when, nested: { ok: true } }), {
      id: 1,
      when: '2026-08-22T18:00:00.000Z',
      nested: { ok: true },
    });
  });

  it('drops cycles instead of throwing or looping', () => {
    const user: { name: string; self?: unknown } = { name: 'admin' };
    user.self = user;
    assert.deepEqual(jsonSafeClone(user), { name: 'admin' });
  });

  it('stops walking past a depth cap', () => {
    let nested: Record<string, unknown> = { value: 0 };
    for (let i = 1; i < 20; i++) {
      nested = { value: i, child: nested };
    }
    const cloned = jsonSafeClone(nested) as Record<string, unknown>;
    let depth = 0;
    let cursor: unknown = cloned;
    while (cursor && typeof cursor === 'object' && 'child' in cursor) {
      depth += 1;
      cursor = (cursor as { child: unknown }).child;
    }
    assert.ok(depth <= 8);
  });

  it('aborts a wide object instead of walking every key', () => {
    const wide: Record<string, Record<string, Record<string, number>>> = {};
    for (let i = 0; i < 80; i++) {
      const inner: Record<string, Record<string, number>> = {};
      for (let j = 0; j < 80; j++) {
        inner[`k${j}`] = { n: j };
      }
      wide[`k${i}`] = inner;
    }
    const started = Date.now();
    const cloned = jsonSafeClone(wide) as Record<string, unknown>;
    assert.ok(Date.now() - started < 500);
    let walked = 0;
    for (const value of Object.values(cloned)) {
      if (value && typeof value === 'object') {
        walked += Object.keys(value).length;
      }
    }
    assert.ok(walked < 80 * 80);
  });

  it('does not walk buffers as byte-index objects', () => {
    const cloned = jsonSafeClone({
      name: 'admin',
      blob: Buffer.alloc(1024 * 1024),
    }) as Record<string, unknown>;
    assert.deepEqual(cloned, { name: 'admin' });
  });
});
