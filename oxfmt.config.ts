import { defineConfig } from 'oxfmt';

export default defineConfig({
  singleQuote: true,
  ignorePatterns: [
    'dist/**',
    '*.min.js',
    'node_modules/**',
    'docs/**',
    'src/spec/**',
    '.agents/**',
    'knowledge/**',
    'scripts/**',
    'tests/**',
    'scratch/**',
  ],
});
