import { mkdirSync } from 'node:fs';
import path from 'node:path';

const BUNFS_ROOT = '/$bunfs/root';

export function isStandaloneExecutable(): boolean {
  return typeof Bun !== 'undefined' && Bun.isStandaloneExecutable === true;
}

export function standaloneRoot(): string {
  return BUNFS_ROOT;
}

export function defaultConfigDirectory(): string {
  if (isStandaloneExecutable()) {
    return path.join(path.dirname(process.execPath), 'config');
  }
  return path.join(__dirname, '../../config');
}

export function configDirectory(): string {
  return process.env.CONFIG_DIRECTORY ?? defaultConfigDirectory();
}

export function bundledPublicPath(): string {
  return path.join(BUNFS_ROOT, 'public');
}

export function bundledApiSpecPath(): string {
  return path.join(BUNFS_ROOT, 'seerr-api.yml');
}

export function bundledLocaleDirectory(): string {
  return path.join(BUNFS_ROOT, 'locale');
}

export function bundledTemplatesDirectory(): string {
  return path.join(BUNFS_ROOT, 'templates');
}

export function emailTemplatePath(templateName: string): string {
  const templatesRoot = isStandaloneExecutable()
    ? bundledTemplatesDirectory()
    : path.join(__dirname, '../templates');
  return path.join(templatesRoot, 'email', templateName);
}

export function ensureConfigDirectory(): void {
  const root = configDirectory();
  mkdirSync(root, { recursive: true });
  mkdirSync(path.join(root, 'db'), { recursive: true });
  mkdirSync(path.join(root, 'logs'), { recursive: true });
}

if (isStandaloneExecutable()) {
  ensureConfigDirectory();
}
