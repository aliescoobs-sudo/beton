import { defineConfig } from 'drizzle-kit';

// Used only to generate migration files (`drizzle-kit generate`); migrations are applied by scripts/db-migrate.ts.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/modules/*/db/*-schema.ts',
  out: './db/migrations',
});
