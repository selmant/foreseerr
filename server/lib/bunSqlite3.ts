import { Database as BunDatabase } from 'bun:sqlite';

type SqliteCallback = (
  this: SqliteRunContext,
  err: Error | null,
  rows?: unknown
) => void;

interface SqliteRunContext {
  lastID: number;
  changes: number;
}

function normalizeParams(
  params?: unknown[] | SqliteCallback,
  cb?: SqliteCallback
): { params: unknown[]; cb?: SqliteCallback } {
  if (typeof params === 'function') {
    return { params: [], cb: params };
  }
  return { params: Array.isArray(params) ? params : [], cb };
}

/**
 * sqlite3-shaped Database that TypeORM's `type: 'sqlite'` driver expects,
 * backed by `bun:sqlite`.
 */
class BunSqliteDatabase {
  #db: BunDatabase;

  constructor(
    filename: string,
    flagsOrCallback?: number | SqliteCallback,
    maybeCallback?: SqliteCallback
  ) {
    const callback =
      typeof flagsOrCallback === 'function' ? flagsOrCallback : maybeCallback;
    try {
      this.#db = new BunDatabase(filename, { create: true });
      if (callback) {
        queueMicrotask(() => callback.call({ lastID: 0, changes: 0 }, null));
      }
    } catch (error) {
      if (callback) {
        queueMicrotask(() =>
          callback.call({ lastID: 0, changes: 0 }, error as Error)
        );
      } else {
        throw error;
      }
    }
  }

  run(
    sql: string,
    params?: unknown[] | SqliteCallback,
    callback?: SqliteCallback
  ): void {
    const { params: values, cb } = normalizeParams(params, callback);
    try {
      const result =
        values.length > 0
          ? this.#db.prepare(sql).run(...values)
          : this.#db.prepare(sql).run();
      const ctx: SqliteRunContext = {
        lastID: Number(result.lastInsertRowid),
        changes: result.changes,
      };
      cb?.call(ctx, null);
    } catch (error) {
      cb?.call({ lastID: 0, changes: 0 }, error as Error);
    }
  }

  all(
    sql: string,
    params?: unknown[] | SqliteCallback,
    callback?: SqliteCallback
  ): void {
    const { params: values, cb } = normalizeParams(params, callback);
    try {
      const rows =
        values.length > 0
          ? this.#db.prepare(sql).all(...values)
          : this.#db.prepare(sql).all();
      cb?.call({ lastID: 0, changes: 0 }, null, rows);
    } catch (error) {
      cb?.call({ lastID: 0, changes: 0 }, error as Error);
    }
  }

  close(callback?: (err: Error | null) => void): void {
    try {
      this.#db.close();
      callback?.(null);
    } catch (error) {
      callback?.(error as Error);
    }
  }
}

/** Passed as TypeORM `driver` so SqliteDriver can call `.verbose()`. */
export const bunSqlite3 = {
  verbose() {
    return { Database: BunSqliteDatabase };
  },
};
