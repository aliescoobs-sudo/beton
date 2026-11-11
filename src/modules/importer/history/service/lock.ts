// R19-07: ONE advisory lock serializes everything that decides or applies a history import: the apply transaction (it reads the effective decisions
// under it), and every mutation of the staging decisions (a label mapping, a quarantine correction). A decision cannot slip in between the read of the
// effective values and their write, and a confirmation is checked against decisions that cannot move while the apply holds the lock.
export const HISTORY_LOCK_SQL = `select pg_advisory_xact_lock(hashtextextended('belgobeton:history-import', 0))`;
