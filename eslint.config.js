// Baseline flat ESLint config so `pnpm lint` (eslint . --max-warnings 0) runs from
// the first commit. It is intentionally conservative: rules are the recommended
// sets without type-aware linting, because the per-workspace tsconfig project
// references do not exist yet. Once the workspaces land, switch the TypeScript
// block to `tseslint.configs.recommendedTypeChecked` with
// `languageOptions.parserOptions.projectService = true`.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/build/**',
      '**/coverage/**',
      '**/.next/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'apps/demo-app/src/generated/**',
      'apps/chrome-extension/public/agent.iife.js',
      'blitzy/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{jsx,tsx}'],
    ...reactHooks.configs['recommended-latest'],
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
);
