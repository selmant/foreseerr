export function publicBasePath(): string {
  if (typeof document !== 'undefined') {
    const runtime = document.querySelector<HTMLMetaElement>(
      'meta[name="foreseerr-base-path"]'
    )?.content;
    if (runtime) return runtime.replace(/\/$/, '');
  }
  const viteBase = import.meta.env.BASE_URL?.replace(/\/$/, '') ?? '';
  if (viteBase && viteBase !== '.' && viteBase !== '/') {
    return viteBase.startsWith('/') ? viteBase : `/${viteBase}`;
  }
  return '';
}

export function withPublicBasePath(path: string): string {
  const base = publicBasePath();
  if (!base || !path.startsWith('/') || path.startsWith('//')) return path;
  if (path === base || path.startsWith(`${base}/`)) return path;
  return `${base}${path}`;
}
