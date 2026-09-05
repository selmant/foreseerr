import {
  SOURCE_ENTITY_GLOB,
  SOURCE_POSTGRES_MIGRATION_GLOB,
  SOURCE_SQLITE_MIGRATION_GLOB,
  SOURCE_SUBSCRIBER_GLOB,
  sourceEntityFiles,
  sourcePostgresMigrationFiles,
  sourceSqliteMigrationFiles,
  sourceSubscriberFiles,
} from '@server/utils/typeormGlobs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const registrySource = readFileSync(
  join(import.meta.dirname, 'compileRegistry.ts'),
  'utf8'
);

function toServerImport(absolutePath: string): string {
  const marker = '/server/';
  const index = absolutePath.lastIndexOf(marker);
  assert.ok(index >= 0, `expected ${marker} in ${absolutePath}`);
  return `@server/${absolutePath.slice(index + marker.length).replace(/\.ts$/, '')}`;
}

describe('compileRegistry', () => {
  it('statically imports every TypeORM entity, subscriber, and migration', () => {
    const groups = [
      [sourceEntityFiles(), SOURCE_ENTITY_GLOB],
      [sourceSubscriberFiles(), SOURCE_SUBSCRIBER_GLOB],
      [sourceSqliteMigrationFiles(), SOURCE_SQLITE_MIGRATION_GLOB],
      [sourcePostgresMigrationFiles(), SOURCE_POSTGRES_MIGRATION_GLOB],
    ] as const;

    for (const [files, glob] of groups) {
      assert.ok(files.length > 0, `expected files for ${glob}`);
      for (const file of files) {
        const importPath = toServerImport(file);
        assert.ok(
          registrySource.includes(`'${importPath}'`),
          `compileRegistry.ts missing ${importPath} (${glob})`
        );
      }
    }
  });
});
