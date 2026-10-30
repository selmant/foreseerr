// Preload for the frontend unit tests (`bun test --preload=./src/test/setup.ts`).
import { createElement } from 'react';

// Bun's global, typed locally so the browser tsconfig needs no bun-types.
declare const Bun: {
  plugin(plugin: {
    name: string;
    setup(build: {
      onLoad(
        options: { filter: RegExp },
        callback: () => { exports: Record<string, unknown>; loader: 'object' }
      ): void;
    }): void;
  }): void;
};

// Vite turns `*.svg` imports into React components (svgr); without this, a
// frontend render test that reaches an icon asset gets a file path as a tag.
Bun.plugin({
  name: 'svg-component-stub',
  setup(build) {
    build.onLoad({ filter: /\.svg$/ }, () => ({
      exports: { default: () => createElement('svg', { 'aria-hidden': true }) },
      loader: 'object',
    }));
  },
});
