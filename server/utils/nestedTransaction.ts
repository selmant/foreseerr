import type { EntityManager } from 'typeorm';

// SQLite shares a query runner, whose savepoint depth can race across saves.
// PostgreSQL gives the nested work a savepoint on the owning connection.
export const withNestedTransaction = <T>(
  manager: EntityManager,
  run: (manager: EntityManager) => Promise<T>
): Promise<T> =>
  manager.connection.options.type === 'sqlite'
    ? run(manager)
    : manager.transaction(run);
