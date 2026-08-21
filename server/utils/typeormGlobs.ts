import { globSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '../..');
const TEST_FILE_PATTERN = /\.test\.[cm]?[jt]sx?$/;

/**
 * TypeORM globs every matching `.ts` file and imports it. Colocated
 * `*.test.ts` files under entity/subscriber directories therefore get loaded
 * as if they were entities, which both registers bogus metadata and — because
 * those files import `node:test` — auto-runs the test suite as a side effect
 * of `DataSource.initialize()` / `runMigrations()`.
 */
export function typeormSourceFiles(pattern: string): string[] {
  return globSync(pattern, { cwd: REPO_ROOT })
    .filter((file) => !TEST_FILE_PATTERN.test(file))
    .sort()
    .map((file) => join(REPO_ROOT, file));
}

export const SOURCE_ENTITY_GLOB = 'server/entity/**/*.ts';
export const SOURCE_SUBSCRIBER_GLOB = 'server/subscriber/**/*.ts';

export const sourceEntityFiles = (): string[] =>
  typeormSourceFiles(SOURCE_ENTITY_GLOB);

export const sourceSubscriberFiles = (): string[] =>
  typeormSourceFiles(SOURCE_SUBSCRIBER_GLOB);
