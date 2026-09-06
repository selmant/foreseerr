// Runs unit tests with Bun. CLI flags stay compatible with the previous
// node:test wrapper so editors and CI can pass files / name patterns through.
//
// PostgreSQL upgrade-matrix files must run in a separate process with
// DB_TYPE=postgres set before any entity import. DbAwareColumn bakes sqlite
// vs postgres column types at first load; Bun's default runner plus
// `test/setup.ts` preload would otherwise keep datetime on MappingCluster
// and fail TypeORM's postgres driver.

import { Command, Option } from 'commander';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_DIR = join(import.meta.dirname, '../..');
const SETUP = fileURLToPath(new URL('./setup.ts', import.meta.url));
const POSTGRES_UPGRADE_TEST = /upgradeMatrix.*\.postgres\.test\.ts$/;
const POSTGRES_UPGRADE_FILES = [
  join(BASE_DIR, 'server/migration/upgradeMatrix.postgres.test.ts'),
  join(
    BASE_DIR,
    'server/migration/upgradeMatrix.foreseerrStable.postgres.test.ts'
  ),
];

const program = new Command();
program
  .name('test')
  .argument('[file...]', 'Test file(s) to run (default: all)')
  .option(
    '-m, --test-name-pattern <pattern>',
    'Run tests matching the given pattern',
    (v, acc: string[]) => [...acc, v],
    [] as string[]
  )
  .option(
    '--test-reporter <reporter>',
    'Ignored; Bun uses its built-in reporters',
    (v, acc: string[]) => [...acc, v],
    [] as string[]
  )
  .option(
    '--test-reporter-destination <dest>',
    'Ignored; CI writes report.xml via Bun junit reporter',
    (v, acc: string[]) => [...acc, v],
    [] as string[]
  )
  .option(
    '--coverage, --experimental-test-coverage',
    'Enable code coverage collection'
  )
  .addOption(new Option('--test').hideHelp())
  .parse();

const positionals: string[] = program.args;
const opts = program.opts<{
  testNamePattern: string[];
  experimentalTestCoverage: boolean;
}>();

// @ts-expect-error NODE_ENV is narrowed by the ambient process type.
process.env.NODE_ENV = 'test';

function isPostgresUpgradeFile(file: string): boolean {
  return POSTGRES_UPGRADE_TEST.test(file.replaceAll('\\', '/'));
}

function bunTestArgs(files: string[], extra: string[] = []): string[] {
  const bunArgs = [
    'test',
    `--preload=${SETUP}`,
    '--max-concurrency=1',
    '--timeout=30000',
    ...extra,
  ];

  if (process.env.CI) {
    bunArgs.push(
      '--reporter=junit',
      `--reporter-outfile=${join(BASE_DIR, 'report.xml')}`
    );
  }

  for (const pattern of opts.testNamePattern) {
    bunArgs.push('-t', pattern);
  }

  if (opts.experimentalTestCoverage) {
    bunArgs.push('--coverage');
  }

  bunArgs.push(...files);
  return bunArgs;
}

async function runBunTest(
  files: string[],
  extraEnv: NodeJS.ProcessEnv = {},
  extraArgs: string[] = []
): Promise<number> {
  const proc = Bun.spawn([process.execPath, ...bunTestArgs(files, extraArgs)], {
    cwd: BASE_DIR,
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
  return proc.exited;
}

const resolvedPositionals = positionals.map((f) => resolve(f));
const requestedPostgres = resolvedPositionals.filter(isPostgresUpgradeFile);
const requestedSqlite = resolvedPositionals.filter(
  (file) => !isPostgresUpgradeFile(file)
);

let exitCode = 0;

if (positionals.length === 0) {
  exitCode = await runBunTest(
    [join(BASE_DIR, 'server')],
    {},
    ['--path-ignore-patterns=**/upgradeMatrix*.postgres.test.ts']
  );
  if (exitCode === 0) {
    exitCode = await runBunTest(POSTGRES_UPGRADE_FILES, {
      DB_TYPE: 'postgres',
    });
  }
} else {
  if (requestedSqlite.length > 0) {
    exitCode = await runBunTest(requestedSqlite);
  }
  if (exitCode === 0 && requestedPostgres.length > 0) {
    exitCode = await runBunTest(requestedPostgres, { DB_TYPE: 'postgres' });
  }
}

process.exit(exitCode);
