import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig(
  globalIgnores([
    'node_modules',
    'dist',
    'esbuild.config.mjs',
    'version-bump.mjs',
    'versions.json',
    '*.js',
    'package-lock.json',
    'tsconfig.json',
  ]),
  {
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.mjs', 'manifest.json'],
        },
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.json'],
      },
    },
  },
  ...obsidianmd.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      'obsidianmd/ui/sentence-case': [
        'warn',
        {
          enforceCamelCaseLower: true,
          ignoreRegex: [
            '^AI Hub$',
            '^tag1, tag2$',
            '^(?:openrouter\\.ai|platform\\.openai\\.com|console\\.groq\\.com)/',
            '^sk-\\.\\.\\.$',
            '^AI-Responses$',
            '^MOCs/$',
          ],
        },
      ],
    },
  },
  {
    // These files execute only in Vitest/Node and are never bundled by the
    // plugin. Keep type-safety rules enabled while excluding mobile runtime
    // checks that do not apply to test fixtures and Node test utilities.
    files: ['**/*.test.ts', '**/*.integration.test.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'obsidianmd/hardcoded-config-path': 'off',
      'obsidianmd/no-nodejs-modules': 'off',
      'obsidianmd/no-tfile-tfolder-cast': 'off',
      'obsidianmd/prefer-window-timers': 'off',
    },
  },
);
