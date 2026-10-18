// Lets plain `node` run scripts that import app code: resolves the "@/…" alias and extensionless
// relative imports to .ts files (Node strips the types itself). Usage: node --import ./scripts/register-ts-paths.mjs <script.ts>
import { register } from 'node:module';

register(
  'data:text/javascript,' +
    encodeURIComponent(`
      import { existsSync } from 'node:fs';
      import { fileURLToPath, pathToFileURL } from 'node:url';
      const root = ${JSON.stringify(new URL('../src/', import.meta.url).href)};
      export async function resolve(specifier, context, next) {
        let target = specifier.startsWith('@/') ? root + specifier.slice(2) : specifier;
        const relative = target.startsWith('.') || target.startsWith('file:');
        if ((specifier.startsWith('@/') || relative) && !/\\.[cm]?[jt]sx?$|\\.json$/.test(target)) {
          for (const suffix of ['.ts', '.tsx', '/index.ts']) {
            const url = new URL(target + suffix, context.parentURL);
            if (existsSync(fileURLToPath(url))) return next(url.href, context);
          }
        }
        return next(target, context);
      }
    `),
);
