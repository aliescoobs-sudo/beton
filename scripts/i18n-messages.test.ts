import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// T16 / AC-MD-09: the fr and ar catalogues have the same keys and placeholders, and every literal key the code asks
// for exists in both (a missing key renders as its path, which is what a blank or garbled screen looks like).
type Tree = { [key: string]: string | Tree };
const fr = JSON.parse(readFileSync('messages/fr.json', 'utf8')) as Tree;
const ar = JSON.parse(readFileSync('messages/ar.json', 'utf8')) as Tree;

function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}
const ary = JSON.parse(readFileSync('messages/ary.json', 'utf8')) as Tree;
const frKeys = flatten(fr);
const arKeys = flatten(ar);
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort();

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('fr and ar catalogues', () => {
  it('have the same keys', () => {
    expect([...frKeys.keys()].filter((k) => !arKeys.has(k))).toEqual([]);
    expect([...arKeys.keys()].filter((k) => !frKeys.has(k))).toEqual([]);
  });

  it('have no empty value and the same {placeholders} for each key', () => {
    for (const [key, text] of frKeys) {
      expect(text.trim(), `fr ${key}`).not.toBe('');
      expect(arKeys.get(key)?.trim(), `ar ${key}`).toBeTruthy();
      expect(placeholders(arKeys.get(key) ?? ''), key).toEqual(placeholders(text));
    }
  });
});

// R8: Darija (Arabic script) overlays Arabic. It may translate less, never a key Arabic does not have, with the same placeholders.
describe('the Darija catalogue', () => {
  it('lists the same language codes in the routing and on the accounts', () => {
    const routingSource = readFileSync('src/i18n/routing.ts', 'utf8');
    const localeSource = readFileSync('src/modules/platform-security/domain/locale.ts', 'utf8');
    const codes = (text: string, re: RegExp) =>
      [...(re.exec(text)?.[1] ?? '').matchAll(/'(\w+)'/g)].map((m) => m[1]);
    expect(codes(routingSource, /locales:\s*\[([^\]]*)\]/)).toEqual(
      codes(localeSource, /USER_LOCALES = \[([^\]]*)\]/),
    );
  });
  const aryKeys = flatten(ary);
  it('only holds keys of the Arabic catalogue, with the same {placeholders} and no empty value', () => {
    expect([...aryKeys.keys()].filter((k) => !arKeys.has(k))).toEqual([]);
    for (const [key, text] of aryKeys) {
      expect(text.trim(), `ary ${key}`).not.toBe('');
      expect(placeholders(text), key).toEqual(placeholders(arKeys.get(key) ?? ''));
    }
  });
  it('translates the driver app (the people who most need it)', () => {
    for (const key of [
      'field.steps.departed',
      'field.emergency',
      'field.options.breakdown',
      'field.acknowledge',
    ])
      expect(aryKeys.has(key), key).toBe(true);
  });
});

describe('translation keys used in the code', () => {
  const files = sourceFiles('src');
  const used: { file: string; key: string; dynamic: boolean }[] = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const namespaces = [
      ...source.matchAll(/(?:useTranslations|getTranslations)\(\s*(?:\{\s*namespace:\s*)?['"]([\w.]+)['"]/g),
    ].map((m) => m[1] as string);
    if (namespaces.length !== 1) continue; // none, or several translators in one file: not checked by name
    for (const m of source.matchAll(/\bt\(\s*(['"`])([\w.${}]+)\1/g)) {
      const key = m[2] as string;
      used.push({ file, key: `${namespaces[0]}.${key}`, dynamic: key.includes('${') });
    }
  }

  it('finds a meaningful number of literal keys', () => {
    expect(used.filter((u) => !u.dynamic).length).toBeGreaterThan(100);
  });

  it('every literal key exists in fr and ar; every dynamic key has an existing parent group', () => {
    const missing: string[] = [];
    for (const { file, key, dynamic } of used) {
      if (dynamic) {
        const group = key.slice(0, key.indexOf('${')).replace(/\.$/, '');
        const exists = [...frKeys.keys()].some((k) => k.startsWith(`${group}.`));
        if (!exists) missing.push(`${file}: ${key} (no keys under ${group})`);
      } else if (!frKeys.has(key) || !arKeys.has(key)) {
        missing.push(`${file}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('master-data UI uses logical properties (RTL)', () => {
  // ml-/mr-/pl-/pr-/left-/right-/text-left/text-right/rounded-l/r flip wrongly in Arabic; use ms-/me-/ps-/pe-/start-/end-.
  const physical =
    /(?:^|[\s"'`:])(?:-?(?:ml|mr|pl|pr|left|right)-(?:\d|\[|px|auto)|text-(?:left|right)|rounded-(?:l|r|tl|tr|bl|br)(?:-|\b)|border-(?:l|r)(?:-|\b)|float-(?:left|right))/;
  const ui = sourceFiles('src').filter((f) => /master-data|\(protected\)|platform-security\/ui/.test(f));

  it.each(ui)('%s has no physical left/right utility class', (file) => {
    const offending = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => /class(Name)?=/.test(line) || /['"`][^'"`]*['"`]/.test(line))
      .filter((line) => physical.test(line));
    expect(offending).toEqual([]);
  });
});
