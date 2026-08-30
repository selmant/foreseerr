/// <reference types="vite/types/importMeta.d.ts" />
/// <reference types="vite-plugin-svgr/client" />

interface ImportMetaEnv {
  readonly COMMIT_TAG: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
  glob: (
    pattern: string,
    options?: { eager?: boolean }
  ) => Record<string, unknown>;
}

declare module '*.svg' {
  import type * as React from 'react';

  const ReactComponent: React.FunctionComponent<
    React.SVGProps<SVGSVGElement> & { title?: string }
  >;

  export default ReactComponent;
}

declare module '*.css' {}
