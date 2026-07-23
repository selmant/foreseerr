#!/usr/bin/env node
/**
 * Verify package.json, Helm chart appVersion, and default image tag stay aligned.
 *
 * Application version in package.json omits the leading "v". Helm appVersion and
 * published container tags include it (e.g. package 0.1.0-alpha.5 -> v0.1.0-alpha.5).
 *
 * Chart version is validated independently and is not compared to app version.
 *
 * Usage:
 *   node scripts/check-version-consistency.mjs
 *   node scripts/check-version-consistency.mjs v0.1.0-alpha.5
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const chartDir = join(root, 'charts', 'foreseer-chart');

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][\da-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][\da-zA-Z-]*))*))?(?:\+([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?$/;

function parseYamlScalar(content, field) {
  const match = content.match(
    new RegExp(`^${field}:\\s*(?:'([^']*)'|"([^"]*)"|(\\S+))\\s*$`, 'm')
  );

  if (!match) {
    return null;
  }

  return match[1] ?? match[2] ?? match[3];
}

function fail(message) {
  console.error(`version consistency: ${message}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const chartYaml = readFileSync(join(chartDir, 'Chart.yaml'), 'utf8');
const valuesYaml = readFileSync(join(chartDir, 'values.yaml'), 'utf8');

const appVersion = parseYamlScalar(chartYaml, 'appVersion');
const chartVersion = parseYamlScalar(chartYaml, 'version');
const imageTag = parseYamlScalar(valuesYaml, 'tag');
const expectedAppVersion = `v${pkg.version}`;
const releaseTag = process.argv[2];

const errors = [];

if (!SEMVER.test(pkg.version)) {
  errors.push(`package.json version "${pkg.version}" is not valid SemVer`);
}

if (!chartVersion || !SEMVER.test(chartVersion)) {
  errors.push(`chart version "${chartVersion}" is not valid SemVer`);
}

if (appVersion !== expectedAppVersion) {
  errors.push(
    `Chart.yaml appVersion is "${appVersion}", expected "${expectedAppVersion}"`
  );
}

if (imageTag && imageTag !== expectedAppVersion) {
  errors.push(
    `values.yaml image.tag is "${imageTag}", expected empty or "${expectedAppVersion}"`
  );
}

if (releaseTag && releaseTag !== expectedAppVersion) {
  errors.push(
    `release tag "${releaseTag}" does not match package.json version (expected "${expectedAppVersion}")`
  );
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`version consistency: ${error}`);
  }
  process.exit(1);
}

console.log(
  `version consistency OK (app ${pkg.version}, chart ${chartVersion}, image tag ${imageTag || expectedAppVersion})`
);
