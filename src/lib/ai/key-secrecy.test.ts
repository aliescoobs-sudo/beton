import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * AC-ASSIST-27: the API key is in .env.local only. This reads the key's value (from the process environment, or from the
 * git-ignored .env.local) in memory and looks for it, and for the shape of a key, in every file the repository could commit
 * and in the build output. A failure names the file and never prints the value.
 */
const ROOT = process.cwd();
const KEY_SHAPE = /sk-ant-[A-Za-z0-9_-]{16,}/;
// The shape inside tests and the spec is a fixture, not a key: those files hold the prefix with a "test" marker.
const FIXTURE_SHAPE = /sk-ant-test-/;

function keyValue(): string | undefined {
  const fromEnv = process.env.ANTHROPIC_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const file = join(ROOT, '.env.local');
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('ANTHROPIC_API_KEY='));
  const value = line
    ?.slice('ANTHROPIC_API_KEY='.length)
    .trim()
    .replace(/^["']|["']$/g, '');
  return value || undefined;
}

function committableFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter(
      (f) => !f.endsWith('.png') && !f.endsWith('.woff2') && !f.endsWith('.ttf') && !f.endsWith('.lock'),
    );
}

function walk(dir: string, into: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const info = statSync(path);
    // The build cache holds compiler intermediates, not what is served or run; what ships is scanned.
    if (info.isDirectory()) {
      if (name !== 'cache') walk(path, into);
    } else if (
      info.size < 8 * 1024 * 1024 &&
      /\.(js|mjs|cjs|json|html|txt|css|map|rsc|body|meta)$/.test(name)
    )
      into.push(path);
  }
  return into;
}

function hits(files: string[], value: string | undefined): string[] {
  const found: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(ROOT, file), 'utf8');
    } catch {
      continue;
    }
    const shape = KEY_SHAPE.exec(text)?.[0];
    if ((shape && !FIXTURE_SHAPE.test(shape)) || (value && text.includes(value))) found.push(file);
  }
  return found;
}

describe('the API key stays out of the repository and the build (AC-ASSIST-27)', () => {
  it('is in no file the repository could commit', () => {
    expect(hits(committableFiles(), keyValue())).toEqual([]);
  });

  it('is in no build output', () => {
    const builds = ['.next', '.next-e2e'].filter((d) => existsSync(join(ROOT, d)));
    const files = builds.flatMap((d) => walk(join(ROOT, d), []).map((f) => f.slice(ROOT.length + 1)));
    expect(hits(files, keyValue())).toEqual([]);
  });

  it('is git-ignored where it lives', () => {
    const ignored = execFileSync('git', ['check-ignore', '.env.local'], { cwd: ROOT }).toString().trim();
    expect(ignored).toBe('.env.local');
  });

  it('has no public name: nothing sends it to the browser', () => {
    const files = committableFiles().filter(
      (f) => /^(src|e2e|scripts|tests)\//.test(f) && /\.(ts|tsx|mjs)$/.test(f),
    );
    const offenders = files.filter(
      (f) =>
        /NEXT_PUBLIC_[A-Z_]*(ANTHROPIC|API_KEY)/.test(readFileSync(join(ROOT, f), 'utf8')) &&
        !f.endsWith('key-secrecy.test.ts'),
    );
    expect(offenders).toEqual([]);
  });

  it('is read by the environment loader and the provider factory only', () => {
    const files = committableFiles().filter((f) => /^src\/.*\.(ts|tsx)$/.test(f) && !f.endsWith('.test.ts'));
    const readers = files.filter((f) => /ANTHROPIC_API_KEY/.test(readFileSync(join(ROOT, f), 'utf8')));
    expect(readers.sort()).toEqual(['src/lib/env.ts', 'src/modules/assistant/service/provider-factory.ts']);
  });
});
