// Runs unit tests with Bun. CLI flags stay compatible with the previous
// node:test wrapper so editors and CI can pass files / name patterns through.

import { Command, Option } from 'commander';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_DIR = join(import.meta.dirname, '../..');
const SETUP = fileURLToPath(new URL('./setup.ts', import.meta.url));

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

const bunArgs = [
  'test',
  `--preload=${SETUP}`,
  '--max-concurrency=1',
  '--timeout=30000',
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

if (positionals.length > 0) {
  bunArgs.push(...positionals.map((f) => resolve(f)));
} else {
  bunArgs.push(join(BASE_DIR, 'server'));
}

const proc = Bun.spawn([process.execPath, ...bunArgs], {
  cwd: BASE_DIR,
  stdout: 'inherit',
  stderr: 'inherit',
  stdin: 'inherit',
  env: process.env,
});

process.exit(await proc.exited);
