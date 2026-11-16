/**
 * Data-scope scan (D249, T19 item 7). KAYAS must NOT store national ID numbers (CIN), birth dates, health data, personal addresses or
 * other sensitive personal data. This scans every migration (column names), the pilot seed, the twin seed (T20) and the importer fixtures for field names
 * that look like one. A finding is an error unless it is in ALLOW with a reason. The allow-list holds BUSINESS identifiers only
 * (ICE, IF, RC, plates, company phone, a company's or site's address). Nothing is dropped silently: every finding is printed.
 *
 *   node --import ./scripts/register-ts-paths.mjs scripts/data-scope-scan.ts
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Finding {
  file: string;
  line: number;
  name: string;
  kind: string;
  table?: string;
  context: string;
}

const KINDS: [string, RegExp][] = [
  [
    'national id (CIN)',
    /(^|_)(cin|cnie|national_?id|id_?card|identity_?(card|number|no)|passport|carte_?nationale)(_|$)/i,
  ],
  ['birth date', /(^|_)(birth|birthday|birthdate|dob|naissance|date_?of_?birth)(_|$)/i],
  [
    'health',
    /(^|_)(health|sante|santé|medical|medic|blood|disease|diagnos\w*|illness|disability|handicap|sick|maladie)(_|$)/i,
  ],
  ['personal address', /(^|_)(home_?address|personal_?address|domicile|residence|adresse_?perso\w*)(_|$)/i],
  ['address (check: business or personal?)', /(^|_)(address|adresse)(_|$)/i],
  [
    'personal contact (check)',
    /(^|_)(personal_?(phone|mobile|email)|mobile_?perso\w*|private_?(phone|email))(_|$)/i,
  ],
];

/** `table.column` (or `*.column`) that is a business field, with the reason. Add here only with a reason; never to hide a personal field. */
export const ALLOW: Record<string, string> = {
  'client.address':
    'a client COMPANY address (business identifier); a natural person client is not stored by address, see client_site',
  'supplier.address': 'a supplier COMPANY address (business identifier)',
  'plant.address': 'the plant (company site) address',
  'company_profile.address': 'the company legal address (document footer)',
  // OPEN QUESTION for Ali and the lawyer (T19 report): these are DELIVERY-SITE addresses (a chantier), sealed (_enc), needed to deliver concrete.
  // They are allowed only as a recorded exception: if the lawyer says a private individual's building site is a "personal address", they must go.
  'client_site.address_enc':
    "delivery site (chantier) address, sealed; operationally required; OPEN QUESTION whether a private individual's site counts as a personal address",
  'trip_instruction.address_enc':
    'delivery site address on a dispatch instruction, sealed; same open question',
  'pump_job.address_enc': 'pump job site address, sealed; same open question',
  'cancellation_case.redirect_address_enc':
    'redirected delivery site address on a cancellation, sealed; same open question',
};

const SQL_COL =
  /^\s*(?:add\s+column\s+(?:if\s+not\s+exists\s+)?)?"?([a-z_][a-z0-9_]*)"?\s+(?:text|varchar|char|int|integer|bigint|smallint|boolean|date|timestamptz|timestamp|numeric|uuid|jsonb?|bytea|citext|[a-z_]+\.[a-z_]+)\b/i;
const TABLE = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:[a-z_]+\.)?"?([a-z_][a-z0-9_]*)"?/i;
const ALTER = /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:[a-z_]+\.)?"?([a-z_][a-z0-9_]*)"?/i;
const SKIP_WORDS = new Set([
  'constraint',
  'primary',
  'unique',
  'check',
  'foreign',
  'create',
  'alter',
  'grant',
  'revoke',
  'insert',
  'select',
  'update',
  'delete',
  'comment',
  'drop',
  'on',
  'for',
  'with',
  'using',
  'to',
  'as',
]);

function classify(name: string): string | null {
  for (const [kind, re] of KINDS) if (re.test(name)) return kind;
  return null;
}

export function scanSql(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  let table: string | undefined;
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/--.*$/, '');
    const t = TABLE.exec(line) ?? ALTER.exec(line);
    if (t) table = t[1];
    const m = SQL_COL.exec(line.replace(/^\s*alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?\S+\s+/i, ''));
    if (!m || SKIP_WORDS.has(m[1]!.toLowerCase())) return;
    const kind = classify(m[1]!);
    if (kind) out.push({ file, line: i + 1, name: m[1]!, kind, table, context: raw.trim().slice(0, 120) });
  });
  return out;
}

/** Object keys and quoted column lists of a TS seed or fixture file. */
export function scanTs(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  text.split('\n').forEach((raw, i) => {
    for (const m of raw.matchAll(/(?:^|[\s{,(])['"]?([a-zA-Z_][a-zA-Z0-9_]*)['"]?\s*:/g)) {
      const kind = classify(m[1]!.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase());
      if (kind) out.push({ file, line: i + 1, name: m[1]!, kind, context: raw.trim().slice(0, 120) });
    }
  });
  return out;
}

export const isAllowed = (f: Finding): boolean =>
  Boolean(f.table && (ALLOW[`${f.table}.${f.name.toLowerCase()}`] ?? ALLOW[`*.${f.name.toLowerCase()}`]));

const walk = (dir: string, ext: RegExp): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? e.name === 'node_modules' || e.name === 'meta'
        ? []
        : walk(join(dir, e.name), ext)
      : ext.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );

export function scanRepo(root = '.'): { all: Finding[]; blocking: Finding[] } {
  const files = [
    ...walk(join(root, 'db'), /\.sql$/),
    join(root, 'src/modules/master-data/service/pilot-seed.ts'),
    join(root, 'src/modules/importer/fixtures.ts'),
    // T20: the fictitious twin seed (its parties, its sheets and its SQL) is scanned like the pilot seed.
    ...walk(join(root, 'scripts/seed/twin'), /\.ts$/).filter((f) => !/\.test\.ts$/.test(f)),
  ];
  const all = files.flatMap((f) => {
    const text = readFileSync(f, 'utf8');
    return f.endsWith('.sql') ? scanSql(f, text) : scanTs(f, text);
  });
  return { all, blocking: all.filter((f) => !isAllowed(f)) };
}

if (process.argv[1]?.endsWith('data-scope-scan.ts')) {
  const { all, blocking } = scanRepo();
  for (const f of all)
    console.log(
      `${isAllowed(f) ? 'allowed ' : 'BLOCKING'}  ${f.file}:${f.line}  ${f.table ?? '-'}.${f.name}  [${f.kind}]  ${f.context}`,
    );
  console.log(`\n${all.length} finding(s), ${blocking.length} blocking`);
  process.exit(blocking.length ? 1 : 0);
}
