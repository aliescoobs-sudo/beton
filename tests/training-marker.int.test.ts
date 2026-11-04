import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { testEnv } from './db-env';

// T1: the marker of a database seeded with the training data. The runtime logins only ask whether it exists.
const env = testEnv();
const migrator = new pg.Pool({ connectionString: env.DATABASE_URL_MIGRATOR, max: 1 });
const app = new pg.Pool({ connectionString: env.DATABASE_URL_APP, max: 1 });
const system = new pg.Pool({ connectionString: env.DATABASE_URL_SYSTEM, max: 1 });
afterAll(() => Promise.all([migrator.end(), app.end(), system.end()]));

describe('training_seeded()', () => {
  it('is false on a clean database, true once the maintenance login has written the marker, and the runtime logins cannot write or read it', async () => {
    expect((await system.query('select public.training_seeded() as s')).rows[0].s).toBe(false);
    await migrator.query('insert into public.training_marker default values');
    try {
      expect((await system.query('select public.training_seeded() as s')).rows[0].s).toBe(true);
      expect((await app.query('select public.training_seeded() as s')).rows[0].s).toBe(true);
      expect((await app.query('select * from public.training_marker')).rowCount).toBe(0); // no policy: nothing is shown
      await expect(app.query('insert into public.training_marker default values')).rejects.toThrow(
        /permission denied/,
      );
      await expect(system.query('delete from public.training_marker')).rejects.toThrow(/permission denied/);
    } finally {
      await migrator.query('delete from public.training_marker');
    }
    expect((await system.query('select public.training_seeded() as s')).rows[0].s).toBe(false);
  });
  it('holds a single row', async () => {
    await migrator.query('insert into public.training_marker default values');
    try {
      await expect(migrator.query('insert into public.training_marker default values')).rejects.toThrow(
        /duplicate key/,
      );
    } finally {
      await migrator.query('delete from public.training_marker');
    }
  });
});
