import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/coverage/**',
      '**/dist/**',
      '**/node_modules/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'artifacts/p2.5/**',
      'artifacts/p3-b0-wasm/**',
      'artifacts/p3-al-ob5/**',
      '**/.tools/**',
      '**/target/**',
      '**/.next/**',
      '**/next-env.d.ts',
      // AR-U4: host app templates, compiled only inside fresh apps against the installed tarballs
      // (tooling/alpha-install-check.mjs type-checks and builds them there).
      'tooling/alpha-install-check/templates/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['**/*.ts', '**/*.mts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    ...tseslint.configs.disableTypeChecked,
    files: ['**/*.mjs'],
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
);
