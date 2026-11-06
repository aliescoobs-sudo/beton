import type pg from 'pg';

// The services open their own transaction per call (`withRlsContext`: BEGIN, set the actor, work, COMMIT). A whole file must be ONE
// transaction, so every service call of the file runs inside the one outer transaction of a single connection, each as a savepoint.
// The outer code alone decides to COMMIT or ROLLBACK; a service's own COMMIT only releases its savepoint, and its ROLLBACK (after a
// refusal) undoes that call only. The audit trigger, row-level security and every check stay the services' own: nothing is bypassed.
//
// Each call's request id is prefixed with the run's tag, so every audit entry written for this file can be found again by it (that is
// what the rollback reads). A test pins this coupling.

export const RUN_TAG_PREFIX = 'import:';

export function singleTransactionPool(client: pg.PoolClient, runId: string): pg.Pool {
  let depth = 0;
  const run = (text: unknown, values?: unknown[]): Promise<pg.QueryResult> => {
    const sql = typeof text === 'string' ? text.trim() : '';
    if (sql === 'BEGIN') return client.query(`SAVEPOINT svc_${++depth}`);
    if (sql === 'COMMIT') return client.query(`RELEASE SAVEPOINT svc_${depth--}`);
    if (sql === 'ROLLBACK') {
      const n = depth--;
      return client
        .query(`ROLLBACK TO SAVEPOINT svc_${n}`)
        .then(() => client.query(`RELEASE SAVEPOINT svc_${n}`));
    }
    if (sql.includes("set_config('app.request_id'") && values && typeof values[2] === 'string') {
      const tagged = [...values];
      tagged[2] = `${RUN_TAG_PREFIX}${runId}|${values[2]}`;
      return client.query(text as string, tagged);
    }
    return client.query(text as string, values);
  };
  const proxyClient = new Proxy(client, {
    get(target, prop) {
      if (prop === 'query') return run;
      if (prop === 'release') return () => undefined;
      const v = Reflect.get(target, prop) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return {
    connect: () => Promise.resolve(proxyClient),
    query: run,
    end: () => Promise.resolve(),
  } as unknown as pg.Pool;
}
