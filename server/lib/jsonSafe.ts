// Generous enough for the largest real responses (TMDB details with full
// credits, keywords and media info) while still bounding runaway graphs.
const MAX_DEPTH = 32;
const MAX_NODES = 200_000;

/**
 * Produce a JSON-compatible clone. TypeORM entities and other graphs can
 * carry cycles or expanding getters; JSON.stringify then never returns and
 * the Node event loop stays at 100% CPU (desktop login freeze).
 *
 * Only true cycles (an object nested inside itself) are dropped. The same
 * object appearing in two sibling branches is ordinary shared data and is
 * cloned in both places, exactly as JSON.stringify would.
 */
export const jsonSafeClone = (value: unknown): unknown => {
  const ancestors = new Set<object>();
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
    if (ancestors.has(input)) {
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
    nodes += 1;
    if (Array.isArray(input)) {
      if (input.length > MAX_NODES) {
        return undefined;
      }
      ancestors.add(input);
      const items = input.map((item) => walk(item, depth + 1));
      ancestors.delete(input);
      return items;
    }
    ancestors.add(input);
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
    ancestors.delete(input);
    return output;
  };

  return walk(value, 0);
};
