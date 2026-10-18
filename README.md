# BELGOBETON

Secure operations brain for a ready-mix concrete company (pilot, **fake data only**).
Start with [docs/BRIEF.md](docs/BRIEF.md), the spec index [CAPABILITY-MAP.md](CAPABILITY-MAP.md) and the plan [tasks/plan.md](tasks/plan.md).

## Requirements

- Node.js 24 (`.nvmrc`)
- pnpm via Corepack (version pinned in `package.json`): run `corepack pnpm <command>`, or `corepack enable` once to get a `pnpm` shim

Dependency install scripts are blocked by default; see `pnpm-workspace.yaml` before allowing one.

## Commands

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm dev          # http://localhost:3000 → /fr or /ar
corepack pnpm lint         # eslint (incl. module boundaries) + prettier --check
corepack pnpm typecheck    # tsc --noEmit
corepack pnpm test         # vitest run (unit + integration; database must be up)
corepack pnpm build
corepack pnpm ci:local     # lint + typecheck + test + audit:verify + build + e2e (CI is local until a private remote exists)
```

## Database (local)

PostgreSQL 17 runs in Docker (Colima on macOS: `brew install colima docker docker-compose`, then `colima start`).

```bash
cp .env.example .env.local                 # fill in; secrets: openssl rand -base64 32 / -hex 16
corepack pnpm db:up                        # start postgres:17.11 on 127.0.0.1:5432
corepack pnpm db:bootstrap                 # superuser, idempotent: roles + belgobeton + belgobeton_test
corepack pnpm db:migrate                   # apply db/migrations as belgobeton_migrator
corepack pnpm test:unit                    # no database needed
corepack pnpm test:integration             # migrates and uses belgobeton_test
```

Roles: `belgobeton_migrator` owns the schema and runs migrations; `belgobeton_app`, `belgobeton_auth` and `belgobeton_system` have no elevated attributes, own nothing and get only explicit grants. Services reach the database only through `withRlsContext()` (`src/lib/db/rls-context.ts`).

## Accounts and browser tests

```bash
corepack pnpm user:create-owner            # the single owner; 2FA enrolment is forced at first login
corepack exec playwright install chromium  # once
corepack pnpm build && corepack pnpm test:e2e   # fr + ar login/enrolment/step-up flow on belgobeton_e2e (~2 min)
```

Scripts may only drop the throwaway databases `belgobeton_test`, `belgobeton_e2e` and `belgobeton_ddl_scratch`.

More commands (backups, audit verification, simulation) arrive with their tasks; the full list is in CAPABILITY-MAP.md §4.

## Module boundaries

`module-map.mjs` mirrors the module map in CAPABILITY-MAP.md §1. A module may import only itself, `src/lib`, `src/i18n` and the modules it depends on; `pnpm lint` fails otherwise. Change the map in CAPABILITY-MAP.md first.
