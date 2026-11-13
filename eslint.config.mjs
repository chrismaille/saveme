import js from '@eslint/js';
import noOnlyTests from 'eslint-plugin-no-only-tests';
import unusedImports from 'eslint-plugin-unused-imports';

const gjsGlobals = {
  ARGV: 'readonly',
  clearInterval: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  global: 'readonly',
  globalThis: 'readonly',
  imports: 'readonly',
  log: 'readonly',
  logError: 'readonly',
  print: 'readonly',
  printerr: 'readonly',
  setInterval: 'readonly',
  setTimeout: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
};

export default [
  {
    ignores: [
      'build/**',
      'dist/**',
      'tools/**',
      'node_modules/**',
      '.venv/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: gjsGlobals,
    },
    plugins: {
      'unused-imports': unusedImports,
    },
    rules: {
      'no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          caughtErrors: 'none',
          varsIgnorePattern: '^_',
        },
      ],
      'no-empty': ['error', {allowEmptyCatch: true}],
      'no-constant-condition': ['error', {checkLoops: false}],
      'eqeqeq': ['error', 'smart'],
      'curly': 'off',
      'no-var': 'error',
      'prefer-const': 'error',
      'no-throw-literal': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',
      'no-useless-return': 'error',
      'no-restricted-globals': ['error', 'event', 'fdescribe', 'fit'],
    },
  },
  {
    files: ['tests/**/*.js'],
    plugins: {
      'no-only-tests': noOnlyTests,
    },
    rules: {
      'no-only-tests/no-only-tests': 'error',
    },
  },
];
