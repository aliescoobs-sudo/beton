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
