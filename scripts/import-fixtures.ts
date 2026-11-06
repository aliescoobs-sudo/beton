// Writes two SYNTHETIC workbooks for rehearsing the import (everything in them is invented: "FICTIF" names, ICE 999…, phones 0600000…):
//   corepack pnpm import:fixtures <folder> [--prefix FK] [--plants CODE1,CODE2]
//   fake-golive-valid.xlsx     every sheet, no problem
//   fake-golive-problems.xlsx  one known fault per line (the report must name them)
// The plants must exist in the database you rehearse on (default FAKEONE,FAKETWO). Never put a real file in this folder.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syntheticProblemWorkbook, syntheticValidWorkbook } from '../src/modules/importer/fixtures.ts';
import { handleHelp } from './cli-help';

handleHelp(import.meta.url);

const args = process.argv.slice(2);
const dir = args[0];
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
if (!dir || dir.startsWith('--')) {
  console.error('usage: import:fixtures <folder> [--prefix FK] [--plants CODE1,CODE2]');
  process.exit(2);
}
const prefix = opt('--prefix') ?? 'FK';
const plants = (opt('--plants') ?? 'FAKEONE,FAKETWO').split(',');
if (!/^[A-Z]{2,4}$/.test(prefix) || plants.length !== 2 || !plants.every((p) => /^[A-Z]{2,8}$/.test(p))) {
  console.error('--prefix: 2 to 4 capital letters; --plants: two plant codes of 2 to 8 capital letters');
  process.exit(2);
}
mkdirSync(dir, { recursive: true });
const options = { prefix, plants: [plants[0]!, plants[1]!] as [string, string] };
for (const [name, content] of [
  ['fake-golive-valid.xlsx', syntheticValidWorkbook(options)],
  ['fake-golive-problems.xlsx', syntheticProblemWorkbook(options)],
] as const) {
  writeFileSync(join(dir, name), content);
  console.log(`written ${join(dir, name)}`);
}
