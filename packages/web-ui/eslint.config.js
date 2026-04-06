import sveltePlugin from 'eslint-plugin-svelte';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import svelteParser from 'svelte-eslint-parser';

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: [
      'dist/',
      'e2e-results/',
      'playwright-report/',
      '.svelte-kit/',
      'e2e/',
      'scripts/',
      // .svelte.ts files use Svelte 5 runes; type-checked by svelte-check, not eslint
      'src/**/*.svelte.ts',
    ],
  },
  // TypeScript files (syntax linting only; type checking via svelte-check)
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  // Svelte files (syntax linting; type checking via svelte-check)
  ...sveltePlugin.configs['flat/recommended'],
  {
    files: ['src/**/*.svelte'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: tsParser,
      },
    },
    rules: {
      // We use DOMPurify for sanitization, so {@html} is safe
      'svelte/no-at-html-tags': 'off',
      // We use immutable Map/Set patterns for Svelte 5 reactivity (new Map on every update)
      'svelte/prefer-svelte-reactivity': 'off',
    },
  },
];
