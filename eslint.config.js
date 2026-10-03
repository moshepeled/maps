// ESLint 10 flat config (SPEC section 3.4). Rule scopes are deliberate; see the comment on each block.
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettierConfig from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** process.env is read only by config modules (backend/src/config/env.ts; the SPA uses frontend/src/config.ts). */
const noProcessEnv = [
  'error',
  {
    object: 'process',
    property: 'env',
    message: 'Read configuration through the validated config module (backend/src/config/env.ts).',
  },
];

/** Output-encoding rule (section 10.7.1): user text never reaches a Leaflet/DOM HTML sink as a string. */
const htmlSinkSelectors = [
  {
    selector:
      'CallExpression[callee.property.name=/^(bindTooltip|bindPopup|setTooltipContent|setPopupContent|divIcon|insertAdjacentHTML)$/]',
    message: 'HTML sink: build content with frontend/src/map/safe-dom.ts (textContent only).',
  },
  {
    selector: "CallExpression[callee.name='divIcon']",
    message: 'HTML sink: build content with frontend/src/map/safe-dom.ts (textContent only).',
  },
  {
    selector: 'AssignmentExpression[left.property.name=/^(innerHTML|outerHTML)$/]',
    message: 'HTML sink: use textContent (or safe-dom.ts).',
  },
  {
    selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
    message: 'dangerouslySetInnerHTML is banned (section 10.7.1).',
  },
];

/** The SPA reads import.meta.env only in frontend/src/config.ts. */
const importMetaEnvSelector = {
  selector: "MemberExpression[object.type='MetaProperty'][property.name='env']",
  message: 'Read build-time flags through frontend/src/config.ts only.',
};

export default defineConfig(
  globalIgnores([
    'docs/**',
    'instractions.md',
    '.claude/**',
    '**/dist/**',
    '**/coverage/**',
    'playwright-report/**',
    'test-results/**',
    'package-lock.json',
  ]),

  // Baseline for every JS/TS file.
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx,mts,cts}'],
    extends: [js.configs.recommended],
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      eqeqeq: ['error', 'always'],
    },
  },

  // Type-aware rules (strictTypeChecked + stylisticTypeChecked) for TS in every workspace and for the @ts-check repo
  // scripts (scripts/tsconfig.json). The project service finds each file's tsconfig.
  {
    files: ['**/*.{ts,tsx,mts,cts}', 'scripts/**/*.mjs'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: {
          // Frontend config files live in tsconfig.node.json (Node types), which the project service does not discover.
          allowDefaultProject: ['frontend/vite.config.ts', 'frontend/vitest.config.ts'],
          defaultProject: 'frontend/tsconfig.node.json',
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // Node environments (learn/: the runnable WebSocket lessons, plain Node 22 scripts).
  {
    files: [
      'backend/**/*.ts',
      'e2e/**/*.ts',
      'scripts/**/*.mjs',
      'learn/**/*.mjs',
      '**/*.config.{ts,js,mjs}',
    ],
    languageOptions: { globals: globals.node },
  },

  // k6 load tests: plain JavaScript run by k6, not Node.
  {
    files: ['loadtest/*.js'],
    languageOptions: { globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly' } },
  },

  // Backend: one structured logger; scripts log through pino too, but may print their results.
  {
    files: ['backend/src/**/*.ts'],
    ignores: ['backend/src/scripts/**'],
    rules: { 'no-console': 'error' },
  },
  {
    files: ['packages/shared/src/**/*.ts'],
    rules: { 'no-console': 'error' },
  },

  // process.env scope (section 3.4): banned in product source, allowed in tests' setup, configs, scripts, e2e and load tests.
  {
    files: ['backend/src/**/*.ts', 'packages/shared/src/**/*.ts', 'frontend/src/**/*.{ts,tsx}'],
    ignores: ['backend/src/config/env.ts'],
    rules: { 'no-restricted-properties': noProcessEnv },
  },

  // Frontend (browser, React).
  {
    files: ['frontend/src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
    rules: { 'no-console': 'error' },
  },
  {
    files: ['frontend/src/**/*.{ts,tsx}'],
    ignores: ['frontend/src/map/safe-dom.ts', 'frontend/src/config.ts'],
    rules: { 'no-restricted-syntax': ['error', ...htmlSinkSelectors, importMetaEnvSelector] },
  },
  {
    // The single HTML-sink wrapper may call the Leaflet APIs, but still may not read build flags.
    files: ['frontend/src/map/safe-dom.ts'],
    rules: { 'no-restricted-syntax': ['error', importMetaEnvSelector] },
  },
  {
    // The single reader of import.meta.env may not touch HTML sinks.
    files: ['frontend/src/config.ts'],
    rules: { 'no-restricted-syntax': ['error', ...htmlSinkSelectors] },
  },

  // Must stay last: turns off every stylistic rule that Prettier owns.
  prettierConfig,
);
