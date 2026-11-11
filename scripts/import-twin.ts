// The fictitious "twin" of the company's monthly files (T11), for rehearsing the history importer and the whole app with realistic volumes.
//   corepack pnpm import:twin <folder> [--seed N]
// Writes into a NEW folder: belgo/ (8 monthly files, no February), chaoun/ (9 files), charges/ (9 files), mapping/ (the three mapping files).
// About 1200 delivery rows for the Tétouan plant and 800 for Chefchaouen, ~160 and ~50 client names, with the real files' structure and known
// problems. Every name carries FICTIF and a marker sheet signs each file as synthetic: the history importer accepts these files on the
// training instance only and refuses them in production mode. Nothing comes from a real file.
import { handleHelp } from './cli-help';
import { writeTwin } from '../src/modules/importer/index.ts';

handleHelp(import.meta.url);
const args = process.argv.slice(2);
const folder = args.find((a) => !a.startsWith('--'));
const seedAt = args.indexOf('--seed');
const seed = seedAt >= 0 ? Number(args[seedAt + 1]) : 1;
if (!folder || !Number.isInteger(seed)) {
  console.error('usage: import:twin <folder> [--seed N]  (see --help)');
  process.exit(2);
}
const written = writeTwin(folder, { seed });
console.log(`${written.length} file(s) written under ${folder}`);
