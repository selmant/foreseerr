const API_PREFIXES = ['/api', '/imageproxy', '/avatarproxy', '/api-docs'];

export function publicBasePath(): string {
  const viteBase = import.meta.env.BASE_URL?.replace(/\/$/, '') ?? '';
  if (viteBase && viteBase !== '.' && viteBase !== '/') {
    return viteBase.startsWith('/') ? viteBase : `/${viteBase}`;
  }
  return '';
}

export function withPublicBasePath(path: string): string {
  const base = publicBasePath();
  if (!base || !path.startsWith('/') || path.startsWith('http')) {
    return path;
  }
  if (path === base || path.startsWith(`${base}/`)) {
    return path;
  }
  if (
    API_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`)
    )
  ) {
    return `${base}${path}`;
  }
  return path;
}
