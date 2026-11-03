// Check seerr-api.yml against the pinned upstream Seerr spec
// (upstream/seerr-api.yml): every operation Foreseerr adds is marked
// `x-foreseerr: true`, and no operation Seerr also has is marked.
//
// The marking is what separates the Seerr-compatible API (which must not
// break; oasdiff checks that in CI) from Foreseerr's own extensions.
// Operations match by method and path, with parameter names ignored.
//
//   bun scripts/check-seerr-api.ts          check
//   bun scripts/check-seerr-api.ts --fix    add or remove the markers
//
// Needs only Bun (Bun.YAML), no node_modules.
import { readFileSync, writeFileSync } from 'node:fs';

const OURS = 'seerr-api.yml';
const UPSTREAM = 'upstream/seerr-api.yml';
const METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
];

type Doc = { paths: Record<string, Record<string, Record<string, unknown>>> };

const shape = (path: string): string => path.replace(/\{[^}]+\}/g, '{}');

const load = (file: string): Doc =>
  Bun.YAML.parse(readFileSync(file, 'utf8')) as Doc;

const upstream = new Set<string>();
for (const [path, item] of Object.entries(load(UPSTREAM).paths)) {
  for (const method of METHODS) {
    if (item[method]) upstream.add(`${method} ${shape(path)}`);
  }
}

const problems: string[] = [];
const toMark: string[] = [];
const toUnmark: string[] = [];
for (const [path, item] of Object.entries(load(OURS).paths)) {
  for (const method of METHODS) {
    const op = item[method];
    if (!op) continue;
    const key = `${method} ${shape(path)}`;
    const marked = op['x-foreseerr'] === true;
    const label = `${method.toUpperCase()} ${path}`;
    if (upstream.has(key) && marked) {
      toUnmark.push(key);
      problems.push(`${label} is a Seerr operation but marked x-foreseerr`);
    } else if (!upstream.has(key) && !marked) {
      toMark.push(key);
      problems.push(
        `${label} is not in Seerr's spec; mark it x-foreseerr: true`
      );
    }
  }
}

if (problems.length === 0) {
  console.log('seerr-api.yml: x-foreseerr markers match the pinned Seerr spec');
  process.exit(0);
}

if (!process.argv.includes('--fix')) {
  for (const problem of problems) console.error(problem);
  console.error(
    `\n${problems.length} problem(s). Run \`bun scripts/check-seerr-api.ts --fix\`.`
  );
  process.exit(1);
}

// The spec's paths are block mappings: a path at two spaces, its methods at
// four, operation keys at six. The marker goes first in the operation.
const MARKER = '      x-foreseerr: true';
const lines = readFileSync(OURS, 'utf8').split('\n');
const out: string[] = [];
let inPaths = false;
let path = '';
let current = '';
for (const line of lines) {
  if (/^\S/.test(line)) inPaths = /^paths:\s*$/.test(line);
  const pathLine = inPaths && line.match(/^ {2}(\/\S*):\s*$/);
  if (pathLine) path = pathLine[1];
  const methodLine = inPaths && line.match(/^ {4}([a-z]+):\s*$/);
  if (methodLine) current = `${methodLine[1]} ${shape(path)}`;
  if (line === MARKER && toUnmark.includes(current)) continue;
  out.push(line);
  if (methodLine && toMark.includes(current)) out.push(MARKER);
}
writeFileSync(OURS, out.join('\n'));
console.log(`fixed ${toMark.length + toUnmark.length} marker(s) in ${OURS}`);
