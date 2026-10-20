import { defineConfig } from 'drizzle-kit';

// Migrations are hand-written SQL in db/migrations and applied by scripts/db-migrate.ts (DECISIONS 43, SQL-first).
// There are no Drizzle table schemas, so `drizzle-kit generate` is not used.
export default defineConfig({
  dialect: 'postgresql',
  out: './db/migrations',
});
