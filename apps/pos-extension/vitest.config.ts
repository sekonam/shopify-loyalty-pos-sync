import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  test: {
    environment: 'jsdom',
    // The tester dynamically imports the extension module named in
    // shopify.extension.toml; inlining it keeps that import inside vite's
    // transform pipeline so .tsx resolves.
    server: { deps: { inline: [/@shopify\/ui-extensions-tester/] } },
  },
});
