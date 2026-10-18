import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import boundaries from 'eslint-plugin-boundaries';
import { allowedModules, moduleDependencies } from './module-map.mjs';

const moduleIds = Object.keys(moduleDependencies);

const config = [
  ...nextVitals,
  ...nextTs,
  {
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts', 'coverage/**'],
  },
  {
    // Business time comes only from the clock module (SPEC-clock §4, AC-CLK-07).
    files: ['src/**/*.{ts,tsx}', 'scripts/**/*.ts'],
    ignores: ['src/modules/clock/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: 'Use clock.now() from the clock module instead of Date.now().',
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: 'Use clock.now() from the clock module instead of new Date().',
        },
        {
          selector: "CallExpression[callee.object.name='performance'][callee.property.name='now']",
          message: 'Use clock.now() from the clock module instead of performance.now().',
        },
      ],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': [
        ...moduleIds.map((id) => ({ type: id, pattern: `src/modules/${id}` })),
        { type: 'lib', pattern: 'src/lib' },
        { type: 'i18n', pattern: 'src/i18n' },
        { type: 'app', pattern: 'src/app' },
      ],
    },
    rules: {
      'boundaries/dependencies': [
        2,
        {
          default: 'disallow',
          policies: [
            // lib and i18n are shared leaves: they import nothing from modules or app.
            {
              from: { element: { types: { anyOf: ['lib', 'i18n'] } } },
              allow: { to: { element: { types: { anyOf: ['lib', 'i18n'] } } } },
            },
            // Each module may import itself, lib, i18n and the modules it depends on (transitively).
            ...moduleIds.map((id) => ({
              from: { element: { type: id } },
              allow: { to: { element: { types: { anyOf: [id, ...allowedModules(id), 'lib', 'i18n'] } } } },
            })),
            // Routes sit on top and may use everything.
            {
              from: { element: { types: { anyOf: ['app'] } } },
              allow: { to: { element: { types: { anyOf: [...moduleIds, 'lib', 'i18n', 'app'] } } } },
            },
          ],
        },
      ],
    },
  },
];

export default config;
