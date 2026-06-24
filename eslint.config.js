import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  prettier,
  {
    ignores: [
      'dist/',
      'node_modules/',
      'packages/',
      'scripts/',
      // Packaged workflow helper scripts (Python/JS) run in-container, not in
      // the TS build — exclude them from the typescript-eslint project parser.
      'src/workflow/workflows/*/scripts/',
      'vitest.config.ts',
      'eslint.config.js',
    ],
  },
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  },
  // Layering boundary: live-runtime modules must not statically VALUE-import
  // from src/pipeline (offline tooling). Type-only imports are allowed
  // (allowTypeImports), and value imports must go through the sanctioned
  // dynamic-import seam (compile-persona-policy.ts / compile-task-policy.ts,
  // which are deliberately NOT in this files list). Scoped to the WS dispatch
  // layer and the not-yet-existing persona-service modules so future phases
  // inherit the guard without breaking the existing sanctioned importers.
  {
    files: [
      'src/web-ui/**/*.ts',
      'src/persona/persona-service.ts',
      'src/persona/persona-compile-orchestrator.ts',
      'src/persona/event-bus-progress-reporter.ts',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/pipeline/**'],
              allowTypeImports: true,
              message:
                'Live-runtime modules must not statically import VALUES from src/pipeline (offline tooling). Use `import type` for contracts, or reach pipeline code via the sanctioned dynamic-import seam (compile-persona-policy.ts / compile-task-policy.ts).',
            },
          ],
        },
      ],
    },
  },
  // Relaxed rules for test files — mocking patterns, deprecated API testing,
  // and vitest callbacks make strict unsafe-* rules too noisy.
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-deprecated': 'off',
      '@typescript-eslint/no-dynamic-delete': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
