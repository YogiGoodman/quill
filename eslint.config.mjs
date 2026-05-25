import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // AGENTS.md: no `any`. Use `unknown` and narrow. Genuine exceptions
      // require an inline eslint-disable with a one-line justification.
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
