import { describe, expect, it } from 'vitest';
import { type FileFacts, historyEnvironmentProblem } from './guard';

const twin: FileFacts = {
  marked: true,
  names: ['KARI FICTIF', 'CHANTIER FICTIF 3'],
  expenseLabels: ['GASOIL 40,00 L', 'DIVERS FICTIF'],
};
const real: FileFacts = { marked: false, names: ['Some Real Name'], expenseLabels: [] };
const training = { trainingMode: true, realData: false, simulationEnabled: false };
const prod = { trainingMode: false, realData: true, simulationEnabled: false };

describe('where and on which files the history import runs', () => {
  it('training mode accepts a marked file whose names are all in the twin vocabulary', () => {
    expect(historyEnvironmentProblem(training, true, [twin, twin])).toBeNull();
  });
  it('training mode refuses a real-looking file (no marker)', () => {
    expect(historyEnvironmentProblem(training, true, [real])).toMatch(/twin/);
    expect(historyEnvironmentProblem(training, true, [twin, real])).toMatch(/twin/);
  });
  it('training mode refuses a marked file that holds a name outside the twin vocabulary', () => {
    expect(
      historyEnvironmentProblem(training, true, [{ ...twin, names: [...twin.names, 'Some Real Name'] }]),
    ).toMatch(/outside the twin vocabulary/);
    expect(
      historyEnvironmentProblem(training, true, [{ ...twin, expenseLabels: ['SALAIRE DE MONSIEUR X'] }]),
    ).toMatch(/outside the twin vocabulary/);
  });
  it('production mode refuses a twin file, whatever the other gates say', () => {
    expect(historyEnvironmentProblem(prod, false, [twin])).toMatch(/synthetic/);
    expect(historyEnvironmentProblem(prod, false, [real, twin])).toMatch(/synthetic/);
  });
  it('production mode runs real files only with REAL_DATA, no simulation, no training marker in the database', () => {
    expect(historyEnvironmentProblem(prod, false, [real])).toBeNull();
    expect(historyEnvironmentProblem(prod, true, [real])).toMatch(/training marker/);
    expect(historyEnvironmentProblem({ ...prod, simulationEnabled: true }, false, [real])).toMatch(
      /SIMULATION/,
    );
    expect(historyEnvironmentProblem({ ...prod, realData: false }, false, [real])).toMatch(/REAL_DATA/);
  });
});
