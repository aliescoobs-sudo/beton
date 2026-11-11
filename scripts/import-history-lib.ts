// Helpers of scripts/import-history.ts and scripts/import-twin.ts, kept apart so they can be tested. Not an entry point.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { InputFile } from '../src/modules/importer/history/service/read-set.ts';
import { parseHistoryMapping, type HistoryMapping } from '../src/modules/importer/history/domain/mapping.ts';

export interface HistoryArgs {
  mode: 'dry-run' | 'stage' | 'apply' | 'rollback' | 'init-mapping' | 'purge-staging' | null;
  target: string | null;
  mapping: string | null;
  account: string | null;
  problems: string[];
}
const MODES = {
  '--dry-run': 'dry-run',
  '--stage': 'stage',
  '--apply': 'apply',
  '--rollback': 'rollback',
  '--init-mapping': 'init-mapping',
} as const;

/** `--dry-run|--stage|--apply <folder>`, `--rollback <batch id>`, `--init-mapping <folder>`; options `--mapping <file>`, `--account <email>`. */
export function parseHistoryArgs(argv: string[]): HistoryArgs {
  const out: HistoryArgs = { mode: null, target: null, mapping: null, account: null, problems: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const next = argv[i + 1];
    if (a === '--purge-staging') {
      if (out.mode && out.mode !== 'purge-staging')
        out.problems.push(`${a} cannot be combined with --${out.mode}`);
      out.mode = 'purge-staging';
      out.target = 'staging'; // no value: it concerns the whole staging
    } else if (a in MODES) {
      const mode = MODES[a as keyof typeof MODES];
      if (out.mode && out.mode !== mode) out.problems.push(`${a} cannot be combined with --${out.mode}`);
      out.mode = mode;
      if (next && !next.startsWith('--')) {
        out.target = next;
        i++;
      } else out.problems.push(`${a} needs a value`);
    } else if (a === '--mapping' || a === '--account') {
      if (!next || next.startsWith('--')) out.problems.push(`${a} needs a value`);
      else {
        if (a === '--mapping') out.mapping = next;
        else out.account = next;
        i++;
      }
    } else if (a !== '--help' && a !== '-h') out.problems.push(`unknown argument ${a}`);
  }
  if (!out.mode && out.problems.length === 0)
    out.problems.push('choose --dry-run, --stage, --apply, --rollback, --purge-staging or --init-mapping');
  if (out.mode && out.mode !== 'init-mapping' && out.mode !== 'dry-run' && !out.account)
    out.problems.push(`--${out.mode} needs --account <email> (the owner or app_admin)`);
  if ((out.mode === 'dry-run' || out.mode === 'stage' || out.mode === 'apply') && !out.mapping)
    out.problems.push(`--${out.mode} needs --mapping <file> (one plant, one kind)`);
  return out;
}

/** The .xlsx files directly inside a folder, in name order (numbered from 1 by their position; the name is never read as data). */
export function listInputFiles(folder: string): InputFile[] {
  const names = readdirSync(folder)
    .filter((n) => /\.xlsx$/i.test(n) && !n.startsWith('~$') && !n.startsWith('.'))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  if (names.length > 200) throw new Error('too many files');
  return names.map((n, i) => {
    const p = path.join(folder, n);
    if (statSync(p).size > 20 * 1024 * 1024) throw new Error(`file ${i + 1} is larger than 20 MB`);
    return { ord: i + 1, buf: readFileSync(p) };
  });
}

export function loadHistoryMapping(file: string): { mapping: HistoryMapping } | { problem: string } {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { problem: 'mapping file: not readable JSON' };
  }
  const r = parseHistoryMapping(json);
  return r.ok ? { mapping: r.value } : { problem: r.problem };
}
