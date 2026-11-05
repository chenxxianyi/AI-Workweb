// ESLint 10 扁平配置（F04）。规则只做"能挡住真实错误"的集合，不做风格争论（风格交给 Prettier）。
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '.data/**',
      '全栈开发任务/存档/**',
      'docs/prototypes/**',
      '**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // 未使用变量交给 tsc 的 noUnusedLocals 把关，避免与类型检查重复报错
      '@typescript-eslint/no-unused-vars': 'off',
      // 允许在受控边界使用非空断言，但显式 any 必须写明理由
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      'no-console': ['warn', { allow: ['error', 'warn'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    files: ['**/*.config.{js,mjs,ts}', '**/scripts/**/*.{js,mjs,ts}'],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
  },
  {
    files: ['apps/api/test/**/*.ts', 'apps/api/src/cli/**/*.ts', 'database/seeds/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
);
