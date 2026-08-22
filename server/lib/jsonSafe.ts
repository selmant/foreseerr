const MAX_DEPTH = 8;
const MAX_NODES = 2_000;

/**
 * Produce a JSON-compatible clone. TypeORM entities and other graphs can
 * carry cycles or expanding getters; JSON.stringify then never returns and
 * the Node event loop stays at 100% CPU (desktop login freeze).
 */
export const jsonSafeClone = (value: unknown): unknown => {
  const seen = new WeakSet<object>();
  let nodes = 0;

  const walk = (input: unknown, depth: number): unknown => {
    if (input === null || typeof input !== 'object') {
      if (typeof input === 'bigint') {
        return input.toString();
      }
      if (typeof input === 'function' || typeof input === 'undefined') {
        return undefined;
      }
      if (typeof input === 'symbol') {
        return undefined;
      }
      if (typeof input === 'number' && !Number.isFinite(input)) {
        return null;
      }
      return input;
    }
    if (depth > MAX_DEPTH || nodes > MAX_NODES) {
      return undefined;
    }
    if (seen.has(input)) {
      return undefined;
    }
    if (input instanceof Date) {
      return Number.isNaN(input.getTime()) ? null : input.toISOString();
    }
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(input)) {
      return undefined;
    }
    if (ArrayBuffer.isView(input)) {
      return undefined;
    }
    seen.add(input);
    nodes += 1;
    if (Array.isArray(input)) {
      if (input.length > MAX_NODES) {
        return undefined;
      }
      return input.map((item) => walk(item, depth + 1));
    }
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input)) {
      if (key.startsWith('__')) {
        continue;
      }
      const next = walk((input as Record<string, unknown>)[key], depth + 1);
      if (next !== undefined) {
        output[key] = next;
      }
      if (nodes > MAX_NODES) {
        break;
      }
    }
    return output;
  };

  return walk(value, 0);
};
