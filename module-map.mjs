// Module dependency map — mirrors CAPABILITY-MAP.md §1 (direct dependencies only).
// Enforced by eslint-plugin-boundaries; change the map in CAPABILITY-MAP.md first.
export const moduleDependencies = {
  clock: [],
  'platform-security': ['clock'],
  'master-data': ['platform-security'],
  ledger: ['master-data', 'clock'],
  operations: ['ledger', 'master-data'],
  'rules-engine': ['ledger', 'operations', 'clock'],
  reconciliation: ['operations', 'platform-security'],
  simulation: ['rules-engine', 'reconciliation', 'clock'],
  notifications: ['rules-engine'],
  'owner-dashboard': ['rules-engine', 'reconciliation', 'notifications'],
  'ai-layer': ['rules-engine', 'reconciliation', 'ledger', 'owner-dashboard'],
};

/** Direct + transitive dependencies of a module. */
export function allowedModules(id, seen = new Set()) {
  for (const dep of moduleDependencies[id] ?? []) {
    if (!seen.has(dep)) {
      seen.add(dep);
      allowedModules(dep, seen);
    }
  }
  return [...seen];
}
