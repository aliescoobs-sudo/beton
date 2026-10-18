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

Owner lost both the authenticator and the recovery codes: on the server, `corepack pnpm user:reset-owner-2fa`
(asks for the database superuser password; audited; the owner and the partner see a security alert until each
acknowledges it).

Scripts may only drop the throwaway databases `belgobeton_test`, `belgobeton_e2e` and `belgobeton_ddl_scratch`.

## Encryption keys

`FIELD_ENCRYPTION_KEYS` and `RECOVERY_CODES_KEYS` are keyrings: `id:base64key[,retired-id:key…]`, current key first.
To rotate: put a new key first (keep the old one after it), restart, run `corepack pnpm crypto:rotate`, check with
`corepack pnpm crypto:rotate --check`, then remove the old key. Columns are registered in
`src/modules/platform-security/domain/encrypted-columns.ts`.

## Backups

Needs `age` (`brew install age`) and the PostgreSQL client tools.

```bash
corepack pnpm backup                 # backups/<ts>.sql.age (age-encrypted pg_dump) + <ts>.audit-anchor.json
corepack pnpm backup:restore-test    # restore the latest into a scratch DB: integrity, migrations, audit chain, anchor
```

The anchor stores the latest audit event id and hash outside the database: a restore whose chain does not match it
fails, which catches a full rewrite of the audit log. Copy both files off the host. The age private key
(`BACKUP_AGE_IDENTITY_FILE`) is only needed for restores and never lives on the app host in production.

More commands (simulation) arrive with their tasks; the full list is in CAPABILITY-MAP.md §4.

## Module boundaries

`module-map.mjs` mirrors the module map in CAPABILITY-MAP.md §1. A module may import only itself, `src/lib`, `src/i18n` and the modules it depends on; `pnpm lint` fails otherwise. Change the map in CAPABILITY-MAP.md first.
