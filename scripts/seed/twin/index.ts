// T20 (D251): the fictitious realistic twin seed. A script, never a migration (decision 79). Deterministic (fixed PRNG seed, fixed anchor date), refuses unless the
// database is explicitly marked fictitious and the environment says so, refuses on any production-looking environment, and does nothing the second time.
// It builds on the training base (`TRAINING_SEED_PROFILE=twin-base`: master data, two plants, one account per role, marker) and reuses those accounts.
import pg from 'pg';
import { TWIN_ANCHOR, TWIN_PRNG_SEED, databaseName, twinEnvProblem } from './guard.ts';
import {
  type TwinContext,
  type TwinSeedEnv,
  TwinSeedError,
  createRng,
  loadAccounts,
  loadPlants,
} from './context.ts';
import { buildHistory } from './history.ts';
import { buildSales } from './sales.ts';
import { buildMoney } from './money.ts';
import { buildStock } from './stock.ts';
import { buildStructure } from './structure.ts';

export interface TwinSeedOptions {
  env: TwinSeedEnv;
  /** The environment variable of the person running the seed (TWIN_SEED_FICTITIOUS); passed in so a test can set it. */
  flag: string | undefined;
  anchor?: string;
}
export interface TwinSeedResult {
  applied: boolean;
}

export async function seedTwin(opts: TwinSeedOptions): Promise<TwinSeedResult> {
  const { env } = opts;
  const problem = twinEnvProblem({ ...env, TWIN_SEED_FICTITIOUS: opts.flag });
  if (problem) throw new TwinSeedError(problem);
  const anchor = opts.anchor ?? TWIN_ANCHOR;

  const pools = {
    app: new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 4 }),
    seed: new pg.Pool({ connectionString: env.DATABASE_URL_SEED, max: 2 }),
    migrator: new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 2 }),
  };
  try {
    // The marker row: the database must carry the training marker (written by the training seed once it completed). Without it, nothing is written.
    if (!(await pools.migrator.query('select 1 from public.training_marker')).rowCount)
      throw new TwinSeedError(
        `twin seed refused: the database ${databaseName(env.DATABASE_URL_MIGRATOR) ?? ''} carries no fictitious marker (training_marker): run the training seed first`,
      );
    if ((await pools.migrator.query('select 1 from public.twin_seed_marker')).rowCount)
      return { applied: false };
    const busy = await pools.migrator.query(
      `select 1 from sales_order union all select 1 from delivery union all select 1 from payment_instrument limit 1`,
    );
    if (busy.rowCount)
      throw new TwinSeedError(
        "twin seed refused: the database already holds orders, loads or payments but no twin marker (a half-finished run or somebody's data): reset the training database and start again",
      );

    const ctx: TwinContext = {
      env,
      pools,
      anchor,
      rng: createRng(TWIN_PRNG_SEED),
      plants: await loadPlants(pools.migrator),
      ...(await loadAccounts(pools.migrator)),
    };
    const world = await buildStructure(ctx);
    await buildSales(ctx, world);
    await buildHistory(ctx, world);
    await buildStock(ctx, world);
    await buildMoney(ctx, world);
    await pools.migrator.query('insert into public.twin_seed_marker (anchor, prng_seed) values ($1, $2)', [
      anchor,
      TWIN_PRNG_SEED,
    ]);
    return { applied: true };
  } finally {
    await Promise.all([pools.app.end(), pools.seed.end(), pools.migrator.end()]);
  }
}
