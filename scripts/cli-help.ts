import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * `--help` / `-h` for a script: prints the leading `//` comment block of the script itself and exits 0, before the
 * script reads any env file or opens a connection. Call it right after the imports. Because static imports are
 * resolved first, running every script with `--help` (scripts/cli-smoke.test.ts) also proves each one still loads.
 */
export function handleHelp(scriptUrl: string): void {
  if (!process.argv.slice(2).some((arg) => arg === '--help' || arg === '-h')) return;
  const usage: string[] = [];
  for (const line of readFileSync(fileURLToPath(scriptUrl), 'utf8').split('\n')) {
    if (!line.startsWith('//')) break;
    usage.push(line.replace(/^\/\/ ?/, ''));
  }
  console.log(usage.join('\n'));
  process.exit(0);
}
