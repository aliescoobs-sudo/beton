import { BUILTIN_CATEGORY_ALIASES, categoryKey, foldKey } from './normalise';

// T11 (decision 210/211): where the history importer may run, and on which files.
//   * TRAINING_MODE=true: ONLY on files that carry the twin marker AND hold no name outside the twin vocabulary (every client, driver and site
//     label contains FICTIF; every expense label is one of the twin's). A real-looking file is refused there.
//   * production mode: real files only, under the real-data gates of T2 (REAL_DATA=true, no simulation, no training marker in the database);
//     a twin-marked file is refused.
// A leaf with no import, shared by the CLI, the service and the tests.

export const TWIN_MARKER_SHEET = 'TWIN_MARKER';
export const TWIN_MARKER_TEXT = 'KAYAS-TWIN-V1 FICTIF SYNTHETIC DATA';
export const TWIN_NAME_MARK = 'FICTIF';

/** The expense labels the twin writes (besides the built-in category words): the guard knows no others. */
export const TWIN_EXPENSE_LABELS = [
  'GASOIL',
  'PNEU',
  'PNEUS',
  'FILTRE',
  'AVANCE',
  'BUREAU',
  'DIVERS FICTIF',
  'REPARATION FICTIF',
  'ENTRETIEN FICTIF',
];

export interface HistoryEnvironment {
  trainingMode: boolean;
  realData: boolean;
  simulationEnabled: boolean;
  /** T10g (R19B-03): the staging profile of the VPS (STAGING_PROFILE=true). The server-side history import is switched off there, in every mode. */
  stagingProfile?: boolean;
}

/** What the guard needs to know about a file: whether it is marked, and the labels that carry a name. Nothing else leaves the reader. */
export interface FileFacts {
  marked: boolean;
  names: string[];
  expenseLabels: string[];
  /** R19-03: the FIELD NAMES (never a cell) in which a retained value is outside what the twin generator can write. */
  contaminated?: string[];
}

/** The reason the environment forbids this history import, or null. `trainingSeeded` is the database's own answer. */
export function historyEnvironmentProblem(
  env: HistoryEnvironment,
  trainingSeeded: boolean,
  files: FileFacts[],
): string | null {
  const marked = files.filter((f) => f.marked).length;
  if (env.stagingProfile)
    return 'The server-side history import is DISABLED on the staging profile (STAGING_PROFILE=true): the complete twin validation is not in place yet (R19B-03), and the only data path of staging is the generated seed. Nothing was read or written.';
  if (env.trainingMode) {
    if (marked !== files.length)
      return 'On the training instance the history import accepts only the fictitious twin files (marker sheet missing in at least one file).';
    for (const f of files) {
      if ((f.contaminated ?? []).length > 0)
        return 'A retained field holds a value the twin generator cannot write: a marker alone is not proof that a file is synthetic, and it is refused on the training instance.';
      if (f.names.some((n) => !foldKey(n).includes(TWIN_NAME_MARK)))
        return 'A name outside the twin vocabulary is present: this is not a twin file, and it is refused on the training instance.';
      const known = new Set([...Object.keys(BUILTIN_CATEGORY_ALIASES), ...TWIN_EXPENSE_LABELS.map(foldKey)]);
      if (f.expenseLabels.some((l) => !known.has(categoryKey(l)) && !known.has(foldKey(l))))
        return 'An expense label outside the twin vocabulary is present: this is not a twin file, and it is refused on the training instance.';
    }
    return null;
  }
  if (marked > 0)
    return 'This file is marked as synthetic (twin) data: the history import in production mode never reads it.';
  if (trainingSeeded)
    return 'This database carries the training marker (fictitious data): the production-mode history import never runs on it.';
  if (env.simulationEnabled)
    return 'SIMULATION_ENABLED is on: this is a demonstration database. The import runs only with REAL_DATA=true and SIMULATION_ENABLED=false.';
  if (!env.realData)
    return 'REAL_DATA is not "true": the history import runs on real files only against the production-mode database.';
  return null;
}
