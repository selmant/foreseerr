import type { ComponentType } from 'react';
import type { RouteObject } from 'react-router';
import { Navigate } from 'react-router';

const pageModules = import.meta.glob('./pages/**/*.{tsx,ts}') as Record<
  string,
  () => Promise<{ default: ComponentType }>
>;

const filePathToRoutePath = (filePath: string): string | null => {
  if (filePath.includes('/_error.')) {
    return null;
  }

  let route = filePath.replace('./pages', '').replace(/\.(tsx|ts)$/, '');

  if (route === '/index' || route === '') {
    return '/';
  }

  if (route.endsWith('/index')) {
    route = route.slice(0, -'/index'.length) || '/';
  }

  route = route.replace(/\[\.\.\.([^\]]+)\]/g, '*$1');
  route = route.replace(/\[([^\]]+)\]/g, ':$1');

  return route;
};

const buildRoutes = (): RouteObject[] => {
  const routes: RouteObject[] = [];

  for (const [filePath, importer] of Object.entries(pageModules)) {
    const routePath = filePathToRoutePath(filePath);
    if (!routePath) {
      continue;
    }

    routes.push({
      path: routePath === '/' ? '/' : routePath,
      lazy: async () => {
        const pageModule = await importer();
        return { Component: pageModule.default };
      },
    });
  }

  routes.sort((a, b) => {
    const aPath = a.path ?? '';
    const bPath = b.path ?? '';
    return bPath.length - aPath.length;
  });

  routes.push({
    path: '*',
    element: <Navigate to="/404" replace />,
  });

  return routes;
};

export default buildRoutes;
