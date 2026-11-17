import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', '.pocketfleet/**', '.worker-*/**'] },
  {
    ...js.configs.recommended,
    files: ['src/**/*.mjs', 'scripts/**/*.mjs', 'test/**/*.mjs', 'public/**/*.js', 'site/**/*.js', 'eslint.config.mjs'],
    languageOptions: { ecmaVersion: 'latest' },
    rules: { 'no-unused-vars': ['error', { ignoreRestSiblings: true, caughtErrors: 'none' }] },
  },
  { files: ['src/**/*.mjs', 'scripts/**/*.mjs', 'test/**/*.mjs', 'eslint.config.mjs'], languageOptions: { globals: globals.node } },
  { files: ['public/**/*.js', 'site/**/*.js'], languageOptions: { sourceType: 'script', globals: globals.browser } },
  { files: ['scripts/browser-check.mjs'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
];
