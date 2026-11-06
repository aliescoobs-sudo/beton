import { describe, expect, it } from 'vitest';
import { importEnvironmentProblem } from './guard';

const prod = { trainingMode: false, realData: true, simulationEnabled: false };

describe('where the import may run', () => {
  it('runs on the production-mode database only', () => {
    expect(importEnvironmentProblem(prod, false)).toBeNull();
  });
  it('refuses TRAINING_MODE=true, whatever else is set', () => {
    expect(importEnvironmentProblem({ ...prod, trainingMode: true }, false)).toMatch(/TRAINING_MODE=true/);
    expect(
      importEnvironmentProblem({ trainingMode: true, realData: false, simulationEnabled: true }, true),
    ).toMatch(/TRAINING_MODE=true/);
  });
  it('refuses a database that carries the training marker even when the flag is off', () => {
    expect(importEnvironmentProblem(prod, true)).toMatch(/training marker/);
  });
  it('refuses a simulated database and an instance that is not in REAL_DATA mode', () => {
    expect(importEnvironmentProblem({ ...prod, simulationEnabled: true }, false)).toMatch(
      /SIMULATION_ENABLED/,
    );
    expect(importEnvironmentProblem({ ...prod, realData: false }, false)).toMatch(/REAL_DATA/);
  });
});
