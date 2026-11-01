const parser = require('@typescript-eslint/parser');
const plugin = require('@typescript-eslint/eslint-plugin');

module.exports = [{
  files: ['src/**/*.ts'],
  languageOptions: { parser, parserOptions: { ecmaVersion: 2022, sourceType: 'module' } },
  plugins: { '@typescript-eslint': plugin },
  rules: {
    'no-debugger': 'error',
    'no-constant-condition': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    '@typescript-eslint/no-explicit-any': 'error',
  },
}];
