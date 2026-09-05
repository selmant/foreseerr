/** Minimal Bun globals used by the server (tsc does not load bun-types). */
declare module 'bun:sqlite' {
  export class Database {
    constructor(
      filename?: string,
      options?: { create?: boolean; readonly?: boolean; readwrite?: boolean }
    );
    prepare(sql: string): Statement;
    close(): void;
  }

  export class Statement {
    run(...params: unknown[]): {
      lastInsertRowid: number | bigint;
      changes: number;
    };
    all(...params: unknown[]): unknown[];
  }
}

declare namespace Bun {
  const password: {
    hash(
      password: string,
      options: { algorithm: 'bcrypt'; cost: number }
    ): Promise<string>;
    verify(password: string, hash: string): Promise<boolean>;
  };
}
