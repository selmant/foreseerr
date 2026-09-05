import {
  SOURCE_ENTITY_GLOB,
  SOURCE_SUBSCRIBER_GLOB,
  sourceEntityFiles,
  sourcePostgresMigrationFiles,
  sourceSqliteMigrationFiles,
  sourceSubscriberFiles,
  typeormSourceFiles,
} from '@server/utils/typeormGlobs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('typeormSourceFiles', () => {
  it('keeps entity modules and drops colocated test files', () => {
    const files = sourceEntityFiles();
    assert.ok(
      files.some((file) => file.endsWith('MediaRequest.ts')),
      `expected MediaRequest.ts in ${SOURCE_ENTITY_GLOB}`
    );
    assert.equal(files.filter((file) => file.endsWith('.test.ts')).length, 0);
  });

  it('keeps subscriber modules and drops colocated test files', () => {
    const files = sourceSubscriberFiles();
    assert.ok(
      files.some((file) => file.endsWith('MediaRequestSubscriber.ts')),
      `expected MediaRequestSubscriber.ts in ${SOURCE_SUBSCRIBER_GLOB}`
    );
    assert.equal(files.filter((file) => file.endsWith('.test.ts')).length, 0);
  });

  it('filters mixed glob results', () => {
    const files = typeormSourceFiles('server/entity/MediaRequest*.ts');
    assert.ok(files.some((file) => file.endsWith('MediaRequest.ts')));
    assert.ok(files.every((file) => !file.includes('.test.')));
  });

  it('lists sqlite and postgres migrations without tests', () => {
    const sqlite = sourceSqliteMigrationFiles();
    const postgres = sourcePostgresMigrationFiles();
    assert.ok(sqlite.some((file) => file.endsWith('InitialMigration.ts')));
    assert.ok(postgres.some((file) => file.endsWith('InitialMigration.ts')));
    assert.equal(sqlite.filter((file) => file.includes('.test.')).length, 0);
    assert.equal(postgres.filter((file) => file.includes('.test.')).length, 0);
  });
});
