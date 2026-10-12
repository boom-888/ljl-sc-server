import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'dist/**', '.build/**', '*.mjs'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: { project: './tsconfig.json' },
      globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly', __dirname: 'readonly', __filename: 'readonly' },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-var-requires': 'off',
      'no-console': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
    },
  },
);
