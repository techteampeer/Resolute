// ESLint flat config — app source (browser React) + Node-side (api/services).
// Scoped to JS/JSX for now; the TypeScript domain core (packages/domain) is
// type-checked by its own build and can gain typescript-eslint later.
import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default [
  { ignores: ['dist/**', 'node_modules/**', 'public/**', 'packages/**', '.audit/**', 'coverage/**'] },
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      // __BUILD_COMMIT__ / __BUILD_TIME__ are injected by Vite `define` at build.
      globals: { ...globals.browser, __BUILD_COMMIT__: 'readonly', __BUILD_TIME__: 'readonly' },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { react, 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...js.configs.recommended.rules,
      // Mark JSX-referenced identifiers (e.g. `motion` in <motion.div>) as used so
      // no-unused-vars doesn't false-positive on them. The React 17+ automatic JSX
      // runtime means jsx-uses-react itself is unneeded.
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'off',
      // High-signal hook rules only. rules-of-hooks catches real bugs (conditional
      // hooks); exhaustive-deps is advisory. The rest of plugin v7's recommended
      // set (static-components, set-state-in-effect) is experimental/stylistic and
      // would demand a broad refactor of valid existing code — not a lint gate's job.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // Unused vars are warnings, not build-breakers; allow intentional
      // uppercase/underscore placeholders and unused error bindings.
      'no-unused-vars': ['warn', { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'react-refresh/only-export-components': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['api/**/*.js', 'services/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
]
