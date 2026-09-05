#!/usr/bin/env bun
const eslint = `${import.meta.dir}/../node_modules/eslint/bin/eslint.js`;
const preload = `${import.meta.dir}/../eslint-typescript-classic.cjs`;

const proc = Bun.spawn(
  [process.execPath, '--preload', preload, eslint, ...process.argv.slice(2)],
  { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }
);

process.exit(await proc.exited);
