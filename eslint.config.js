import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'coverage/**',
      'dist/**',
      'eslint.config.js',
      'node_modules/**',
      'playwright-report/**',
      'public/generated/**',
      'tests/fixtures/**',
      'test-results/**',
      'vendor/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  // Hook rules are the only automated guard on effect dependencies, and a stale
  // or over-broad dependency array here means a torn-down animation loop or a
  // controller that never restarts.
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    extends: [reactHooks.configs.flat['recommended-latest']],
  },
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true },
      ],
    },
  },
);
