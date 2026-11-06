// Where the Excel import may run (T2). The import writes the company's real master data and opening figures, so it runs only against
// the production-mode database: never on the training instance, never on a simulated database, never on a database that holds the
// training seed. A leaf with no import, so the CLI, the service and the tests share the same rule.

export interface ImportEnvironment {
  /** TRAINING_MODE. */
  trainingMode: boolean;
  /** REAL_DATA: the instance is the production one. */
  realData: boolean;
  /** SIMULATION_ENABLED: a demo database with a clock that can be advanced. */
  simulationEnabled: boolean;
}

/** Why the import must not run here, or null when it may. `trainingSeeded` is the database's own answer (`training_seeded()`). */
export function importEnvironmentProblem(env: ImportEnvironment, trainingSeeded: boolean): string | null {
  if (env.trainingMode)
    return 'Imports are switched off on the training instance (TRAINING_MODE=true): its data come from seed:training.';
  if (trainingSeeded)
    return 'This database carries the training marker (fictitious data): the import never runs on it.';
  if (env.simulationEnabled)
    return 'SIMULATION_ENABLED is on: this is a demonstration database, not the production one. The import runs only with REAL_DATA=true and SIMULATION_ENABLED=false.';
  if (!env.realData)
    return 'REAL_DATA is not "true": the import runs only against the production-mode database.';
  return null;
}
