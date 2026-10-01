import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  test: {
    environment: 'jsdom',
    server: { deps: { inline: [/@shopify\/ui-extensions-tester/] } },
  },
});
