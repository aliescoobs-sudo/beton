# Task list: `platform-security` + `clock`

Plan: [tasks/plan.md](plan.md). Each task lists the spec ACs it closes. Standard verification for every task (in addition to the task's own): `pnpm lint && pnpm typecheck && pnpm test`, plus `pnpm build` from T1 on. Commit after each task.

---

## Phase 0 — Foundation

### - [x] T1: Project scaffold (fr/ar shell, tooling)
**Description:** Next.js (App Router) + TypeScript strict + pnpm + Tailwind (logical properties) + next-intl with `fr`/`ar` locales and `dir="rtl"` for `ar`; ESLint + Prettier + `eslint-plugin-boundaries` (module dependency rules from CAPABILITY-MAP §1); Vitest; `pg` driver; `.nvmrc` (Node 24); README with the commands from CAPABILITY-MAP §4. CI is local only for now: `pnpm ci:local` runs lint, typecheck, test, build (and later e2e, audit:verify); no GitHub Actions workflow until a private remote exists.
**Acceptance criteria:**
- [x] `/fr` and `/ar` render an empty shell; `<html dir="rtl" lang="ar">` on `/ar`
- [x] `pnpm lint`, `pnpm typecheck`, `pnpm test` (1 smoke test), `pnpm build` pass
- [x] `.gitignore` covers `.env*`, `backups/`, `node_modules/`, `.next/`
- [x] `pnpm ci:local` runs the full local pipeline; a fixture import from a non-dependency module fails `pnpm lint` (boundaries rule)
**Verification:** commands above; manual check of both locales in a browser.
**Dependencies:** none · **Files:** package.json, tsconfig.json, next.config.ts, eslint.config.mjs, vitest.config.ts, src/app/[locale]/layout.tsx + page.tsx, src/i18n/*, messages/fr.json, messages/ar.json (accepted > 5-file exception: boilerplate) · **Scope:** M

### - [x] T2: Env validation + redacting logger
**Description:** `src/lib/env.ts` validates all env vars with Zod at boot (DB URLs per role, auth secret, field-encryption key, backup recipient, `SIMULATION_ENABLED`, `REAL_DATA`); `.env.example` lists names only. Structured JSON logger with a redaction list (passwords, tokens, secrets, cookies, emails, phones).
**Acceptance criteria:**
- [x] App/process exits with a clear message when a required var is missing (AC-SEC-11)
- [x] A test logging an object with `password`, `token`, `cookie` fields outputs them as `[REDACTED]`; a log-scan test finds no env secret values in captured logs (AC-SEC-11)
**Verification:** `pnpm test src/lib/env src/lib/logger` · **Dependencies:** T1 · **Files:** src/lib/env.ts, src/lib/logger.ts, .env.example, tests · **Scope:** S

### - [x] T3: Clock (real mode) + `Date.now()` ban
**Description:** `src/modules/clock` exposes `clock.now()`, `clock.today()` (`BusinessDate` in Africa/Casablanca), and a test clock (`createTestClock`). ESLint `no-restricted-syntax`/`no-restricted-globals` bans `Date.now()`, `new Date()` without args, and `performance.now()` for business time outside `src/modules/clock`.
**Acceptance criteria:**
- [x] `clock.now()` tracks real time in real mode (AC-CLK-01, real part)
- [x] `clock.today()` returns the Casablanca date across the local midnight boundary, for both UTC+1 and UTC+0 periods (offsets from IANA tz data, not hard-coded)
- [x] Lint fails on a fixture file using `Date.now()` outside the clock module (AC-CLK-07)
**Verification:** `pnpm test src/modules/clock`; `pnpm lint` on a fixture · **Dependencies:** T1 · **Files:** src/modules/clock/{index.ts,domain/business-date.ts,service/clock.ts}, eslint.config.mjs, tests · **Scope:** S

### - [x] T4: DB roles, migrations, RLS context helper, test harness
**Description:** docker-compose Postgres 17; drizzle-kit config; roles created by an idempotent superuser script `scripts/db-bootstrap.ts` (role DDL needs the superuser, so it can't be a migration run as migrator); roles `belgobeton_migrator`, `_app`, `_auth`, `_system` with no elevated attributes (no `BYPASSRLS`, app is not owner); first SQL migration = schema hardening + `ctx.*()` helpers with minimal grants. `withRlsContext(ctx, fn)` = transaction + `set_config('app.user_id'|'app.role'|'app.request_id'|'app.sim_at', v, true)`. Integration test harness: a compose test DB, migrations applied once, per-test transaction rollback or schema reset.
**Acceptance criteria:**
- [x] Test asserts `app` role: `rolbypassrls = false`, owns no tables, cannot `CREATE` in `public`
- [x] Settings set inside `withRlsContext` are invisible to the next transaction on the same pooled connection (leak test with pool size 1)
- [x] `pnpm db:migrate` is idempotent on a fresh and an already-migrated DB
**Verification:** `pnpm db:up && pnpm db:bootstrap && pnpm db:migrate && pnpm test:integration` · **Dependencies:** T2, T3 · **Files:** docker-compose.yml, drizzle.config.ts, db/migrations/0000_roles.sql, src/lib/db/{pool.ts,rls-context.ts}, tests/setup-db.ts · **Scope:** M

### Checkpoint CP1 — Foundation
- [ ] All commands green; both locales render; app role verified non-privileged
- [ ] Review with Ali before Phase 1

---

## Phase 1 — Audit log (security core)

### - [x] T5: `audit_event` table, immutable
**Description:** Create `audit_event` (columns per SPEC §3). `REVOKE UPDATE, DELETE, TRUNCATE` from all roles incl. migrator; `BEFORE UPDATE OR DELETE` trigger raising; `INSERT` only via the trigger function / `audit.record()` (SECURITY DEFINER, fixed `search_path`).
**Acceptance criteria:**
- [x] `UPDATE`, `DELETE`, `TRUNCATE` on `audit_event` fail for `app` and `migrator` (AC-SEC-07, audit part)
- [x] Direct `INSERT` by `app` is refused; `audit.record()` works
**Verification:** `pnpm test db/audit` (integration) · **Dependencies:** T4 · **Files:** db/migrations/0001_audit.sql, src/modules/platform-security/db/audit-schema.ts, tests · **Scope:** S

### - [x] T6: Generic audit capture trigger
**Description:** `audit.capture()` trigger function (AFTER INSERT OR UPDATE) writes before/after jsonb, actor from `app.user_id`, `actor_kind`, `request_id`, `sim_at`; raises if `app.user_id` is missing. Helper migration macro `audited_table('<name>')` attaches it. Tested on a test-only `audit_probe` table. `auditService.record()` for service-level events (login, permission_denied…).
**Acceptance criteria:**
- [x] Insert/update on `audit_probe` without `app.user_id` fails (AC-SEC-06)
- [x] Each insert/update produces exactly one event with actor, real time, before/after (AC-SEC-08, capture part)
- [x] Encrypted-column placeholder values are logged as stored (no decryption in trigger)
**Verification:** `pnpm test db/audit` · **Dependencies:** T5 · **Files:** db/migrations/0002_audit_capture.sql, src/modules/platform-security/service/audit-service.ts, tests · **Scope:** S

### - [ ] T7: Hash chain + `pnpm audit:verify`
**Description:** In the trigger: `hash = sha256(prev_hash || canonical_json(event))` under `pg_advisory_xact_lock`. Canonical JSON defined once and shared by SQL and the TS verifier. `scripts/audit-verify.ts` recomputes the chain and reports the first broken id.
**Acceptance criteria:**
- [ ] 100 parallel inserts produce a valid chain; completes < 2 s locally
- [ ] Altering one stored event as superuser (test only) makes `audit:verify` fail and name that event (AC-SEC-08)
- [ ] `pnpm audit:verify` exits 0 on a clean DB
**Verification:** `pnpm test db/audit && pnpm audit:verify` · **Dependencies:** T6 · **Files:** db/migrations/0003_audit_chain.sql, src/modules/platform-security/domain/canonical-json.ts, scripts/audit-verify.ts, tests · **Scope:** M

### Checkpoint CP2 — Audit
- [ ] AC-SEC-06/07/08 (probe) green; `audit:verify` in the test pipeline
- [ ] Review with Ali before Phase 2

---

## Phase 2 — Identity

### - [ ] T8: Auth library spike + go/no-go (🟡 A1)
**Description:** Time-boxed spike on a throwaway branch: Better Auth + Drizzle adapter on the `auth` DB role; check argon2id hasher (open question 1), `__Host-` cookie with `Secure; HttpOnly; SameSite=Strict`, idle 30 min + absolute 12 h, rotation on login/2FA, server-side revoke, TOTP + recovery codes, where TOTP secrets are stored and how they're encrypted, hooks for audit events, ability to read time from `clock`. Write `docs/adr/0001-auth-library.md` with the verdict; if no-go, the ADR describes the fallback (argon2id + otplib + own session table).
**Acceptance criteria:**
- [ ] ADR lists each requirement with pass/fail + evidence (test or doc link)
- [ ] Decision approved by Ali before T9 starts
**Verification:** ADR review · **Dependencies:** T4, T7 · **Files:** docs/adr/0001-auth-library.md (spike code not merged) · **Scope:** S

### - [ ] T9: Owner bootstrap + password login + lockout
**Description:** `app_user` (role, locale, status) + auth tables per ADR; `pnpm user:create-owner` CLI (prompts, refuses if an owner exists, audited as `system/bootstrap`); login page (fr/ar) with password; argon2id via `@node-rs/argon2`; local common-password check against the bundled top-10k list (`src/modules/platform-security/data/common-passwords.txt` + `LICENSE-common-passwords.md` keeping the SecLists MIT notice); rate limits (5/15 min per account → 15-min lock; 20/15 min per IP); identical error text for unknown email and wrong password; login/failed-login audit events. After password success the user lands on the 2FA step (T10); no other page is reachable.
**Acceptance criteria:**
- [ ] 5 failed logins lock the account for 15 min; error text identical for unknown email / wrong password (AC-SEC-02, password part)
- [ ] CLI refuses a second owner and passwords < 12 chars or on the common list
- [ ] Login success/failure produce audit events without the password or email in plaintext
**Verification:** `pnpm test src/modules/platform-security` + Playwright `e2e/auth-login.spec.ts` · **Dependencies:** T8 · **Files:** src/modules/platform-security/{db/user-schema.ts,service/auth-service.ts,ui/login-form.tsx}, src/app/[locale]/login/page.tsx, scripts/create-owner.ts, src/modules/platform-security/data/{common-passwords.txt,LICENSE-common-passwords.md} · **Scope:** M

### - [ ] T10: Forced TOTP enrolment + recovery codes
**Description:** After the first password login: QR + manual key enrolment, confirm with a code, show 10 recovery codes once (stored hashed). Later logins require TOTP (±1 step) or a recovery code (single use). Any route other than enrolment/2FA redirects there until done.
**Acceptance criteria:**
- [ ] A user without TOTP enrolled cannot reach any page except enrolment (AC-SEC-01)
- [ ] Correct password + wrong TOTP fails and counts toward lockout (AC-SEC-02)
- [ ] A recovery code works once, then is refused
**Verification:** unit (TOTP window with test clock) + `e2e/auth-2fa.spec.ts` in fr and ar · **Dependencies:** T9 · **Files:** src/modules/platform-security/{service/two-factor.ts,ui/enrol-totp.tsx,ui/verify-totp.tsx}, src/app/[locale]/(auth)/2fa/*, middleware gate · **Scope:** M

### - [ ] T11: Session lifetimes, rotation, logout
**Description:** Idle 30 min, absolute 12 h, both read from `clock`; session id rotated on login and on 2FA; logout deletes the session server-side; `two_factor_at` recorded.
**Acceptance criteria:**
- [ ] Session refused after 30 min idle and after 12 h absolute with continuous activity (test clock) (AC-SEC-03)
- [ ] Session id differs before/after login and after 2FA
- [ ] After logout, replaying the old cookie is refused
**Verification:** `pnpm test session` + e2e logout check · **Dependencies:** T10 · **Files:** src/modules/platform-security/service/session.ts, middleware, tests · **Scope:** S

### - [ ] T12: Step-up 2FA guard
**Description:** `requireRecentTwoFactor(10 min)` for actions marked sensitive; UI re-prompt dialog that retries the action after a successful TOTP; registry of sensitive actions (from SPEC §5) in code.
**Acceptance criteria:**
- [ ] A sensitive action with `two_factor_at` older than 10 min is not executed and prompts TOTP; after success it runs once (AC-SEC-09)
- [ ] Non-sensitive actions are unaffected
**Verification:** unit + e2e with a test-only sensitive action · **Dependencies:** T11 · **Files:** src/modules/platform-security/{service/step-up.ts,ui/step-up-dialog.tsx}, tests · **Scope:** S

### Checkpoint CP3 — Identity
- [ ] Login → enrolment → 2FA → step-up → logout works end-to-end in fr and ar
- [ ] ADR 0001 accepted; review with Ali before Phase 3

---

## Phase 3 — Authorization

### - [ ] T13: Permission matrix, guards, user admin
**Description:** `permissions.ts` encodes SPEC §4. `requirePermission()` for routes/server actions (default deny → 404) and services; `permission_denied` audit events. First consumer: owner-only user admin (create user with role and locale, disable, reset 2FA — all sensitive/step-up). Disabling a user revokes their sessions.
**Acceptance criteria:**
- [ ] A route/action without a declared permission fails a meta-test
- [ ] Non-owner gets 404 on user admin; attempt is audited
- [ ] Disabling a user ends their sessions immediately; their audit history is intact (AC-SEC-14)
**Verification:** unit + `e2e/user-admin.spec.ts` · **Dependencies:** T12 · **Files:** src/modules/platform-security/{domain/permissions.ts,service/guard.ts,service/user-admin.ts,ui/users/*}, src/app/[locale]/admin/users/* · **Scope:** M

### - [ ] T14: RLS policies + generated matrix test
**Description:** `ENABLE` + `FORCE ROW LEVEL SECURITY` and policies for all tables existing so far (`app_user`, `audit_event` — all for owner/partner, own actions for office/plant —, `parameter` placeholder, `scheduled_job_run`, `sim_clock` later). Test generator: for each table × role in the matrix, assert allowed reads return rows and denied reads return 0 rows via direct SQL as `app`. Meta-test: every table in the schema (except the allow-list of auth tables on the `auth` role) has FORCE RLS, the audit trigger, and a matrix entry.
**Acceptance criteria:**
- [ ] Matrix test green for every existing table × 4 roles (AC-SEC-04)
- [ ] Adding a table without RLS/trigger/matrix entry makes the meta-test fail (checked with a fixture migration)
- [ ] `app` role cannot read auth/credential tables at all
**Verification:** `pnpm test -- --project integration rls` · **Dependencies:** T13 · **Files:** db/migrations/0004_rls_platform.sql, tests/rls/matrix.int.test.ts, tests/rls/meta.int.test.ts · **Scope:** M

### - [ ] T15: Role-scoped projection helper (field hiding)
**Description:** `project(role, entity, row)` returns only the fields the role may see (map from `permissions.ts`); `expectNoFields(response, fields)` test helper for API and DOM. Used by later modules to close AC-SEC-05.
**Acceptance criteria:**
- [ ] Unit tests on a sample entity: plant projection drops price fields, office projection drops margin fields
- [ ] Helper documented in the module's `index.ts`
**Verification:** `pnpm test projection` · **Dependencies:** T14 · **Files:** src/modules/platform-security/domain/projection.ts, tests/helpers/expect-no-fields.ts · **Scope:** XS

### Checkpoint CP4 — Authorization
- [ ] AC-SEC-04 and AC-SEC-14 green; review with Ali before Phase 4

---

## Phase 4 — Data protection and operations
(T16–T18 can run in parallel with Phase 2–3 after CP2.)

### - [ ] T16: Field encryption + HMAC lookup + key rotation
**Description:** `src/lib/crypto/field.ts`: AES-256-GCM with random 96-bit IV, key id prefix, keys from env (current + previous); keyed HMAC-SHA256 for searchable lookups; `pnpm crypto:rotate` re-encrypts rows from old to new key id. Apply to TOTP secrets if the auth library doesn't already encrypt them (per ADR).
**Acceptance criteria:**
- [ ] Raw `SELECT` of an encrypted column shows no plaintext; decrypt round-trip works; tampered ciphertext fails authentication (AC-SEC-10)
- [ ] Rotation re-encrypts all rows to the new key id; old key can then be removed
**Verification:** `pnpm test crypto` (unit + integration) · **Dependencies:** T4 · **Files:** src/lib/crypto/field.ts, src/lib/crypto/hmac.ts, scripts/crypto-rotate.ts, tests · **Scope:** S

### - [ ] T17: Security headers + nonce CSP
**Description:** `src/proxy.ts` sets a per-request nonce CSP (`default-src 'self'`, `script-src 'nonce-…' 'strict-dynamic'`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`), `X-Content-Type-Options`, `Referrer-Policy: same-origin`, minimal `Permissions-Policy`, HSTS in non-local envs.
**Acceptance criteria:**
- [ ] Every response carries the headers (AC-SEC-13), checked by an integration test over 3 routes
- [ ] Playwright: no CSP violation in the console on login and home, in fr and ar
**Verification:** `pnpm test headers && pnpm test:e2e headers` · **Dependencies:** T1 · **Files:** src/proxy.ts, src/lib/security-headers.ts, tests · **Scope:** S

### - [ ] T18: Encrypted backup + restore test
**Description:** `pnpm backup` = `pg_dump` (as migrator) piped to `age -r $BACKUP_AGE_RECIPIENT` into `backups/<ts>.sql.age` (gitignored). `pnpm backup:restore-test` decrypts with the key from a path given by env, restores into a scratch DB, checks migration status and row counts, runs `audit:verify`. Fails clearly if `age` isn't installed.
**Acceptance criteria:**
- [ ] Backup file is not readable as SQL without the key (AC-SEC-12)
- [ ] Restore test passes on a fresh backup, including `audit:verify` (AC-SEC-12)
**Verification:** run both commands locally against the dev DB · **Dependencies:** T7 · **Files:** scripts/backup.ts, scripts/restore-test.ts, README section · **Scope:** S

### - [ ] T19: Parameters store
**Description:** Typed parameter registry in code (key, Zod schema, default, owner-only write): first entries = session/lockout values and clock job times (later modules add their own). Owner edit screen (sensitive → step-up); partner read-only; every change audited.
**Acceptance criteria:**
- [ ] Invalid values rejected by schema; defaults used when unset
- [ ] Partner sees values read-only; office/plant get 404; changes require step-up and produce audit events
**Verification:** unit + RLS matrix entry + e2e edit · **Dependencies:** T13, T14 · **Files:** src/modules/platform-security/{domain/parameters.ts,service/parameter-service.ts,ui/parameters/*}, db/migrations/0005_parameters.sql · **Scope:** M

### - [ ] T20: Audit log viewer
**Description:** Screen with filters (date, person, entity, action), paginated; owner/partner see all, office/plant see own actions (RLS from T14); reusable "Historique" tab component for later record pages.
**Acceptance criteria:**
- [ ] Office user sees only their own events (RLS-enforced, not UI-filtered)
- [ ] Viewer shows before/after diff for an update event
**Verification:** integration + e2e · **Dependencies:** T19 · **Files:** src/modules/platform-security/{service/audit-query.ts,ui/audit/*}, src/app/[locale]/historique/page.tsx · **Scope:** S

### - [ ] T21: Security checklist + fake-data banner
**Description:** `security_checklist_item` seeded with the D37 items (SPEC §8); owner can mark items with evidence (sensitive); the automated items (CI security tests, restore test < 7 days, all users 2FA, no seed accounts) are computed. A "Données fictives uniquement" banner shows until all pass and the owner signs off; `REAL_DATA=true` refuses to boot unless the checklist is complete.
**Acceptance criteria:**
- [ ] Banner visible on every page while any item is open
- [ ] Boot with `REAL_DATA=true` and an incomplete checklist fails
**Verification:** integration + e2e · **Dependencies:** T18, T19 · **Files:** src/modules/platform-security/{service/checklist.ts,ui/checklist/*,ui/fake-data-banner.tsx}, db/migrations/0006_checklist.sql · **Scope:** M

### Checkpoint CP5 — Data protection
- [ ] AC-SEC-10, 12, 13 green; parameters, audit viewer and checklist working; review with Ali before Phase 5

---

## Phase 5 — Clock simulation

### - [ ] T22: Simulated mode + boot guards + sim badge
**Description:** `sim_clock` singleton (only when `SIMULATION_ENABLED=true`); `clock.now()` reads `sim_now` (cached per request); `app.sim_at` set in every `withRlsContext`; boot refuses `SIMULATION_ENABLED=true` with `NODE_ENV=production` or `REAL_DATA=true`; permanent sim-date badge in the layout; `sim_now` can only move forward (DB check + service).
**Acceptance criteria:**
- [ ] With simulation disabled, `advance` is not exposed (route 404, service throws) (AC-CLK-01)
- [ ] Boot fails for the forbidden env combinations (AC-CLK-02)
- [ ] Setting `sim_now` backwards fails (AC-CLK-05)
- [ ] Audit events carry `sim_at` in sim mode (AC-SEC-08, sim part)
**Verification:** unit + integration + e2e badge check · **Dependencies:** T14, T19 · **Files:** src/modules/clock/{db/sim-clock-schema.ts,service/clock.ts,ui/sim-badge.tsx}, db/migrations/0007_sim_clock.sql, src/lib/env.ts · **Scope:** M

### - [ ] T23: Job runner (pg-boss + idempotent runs)
**Description:** Job registry (`job_key`, business time, handler); real mode: pg-boss cron in Africa/Casablanca triggers handlers; `scheduled_job_run (job_key, business_date)` unique → a second run of the same job/day is a no-op. The four catalogue jobs are registered as stubs (logged no-ops) until their modules exist. Jobs run as the `system` actor.
**Acceptance criteria:**
- [ ] Running the same job for the same business date twice runs the handler once (AC-CLK-03, idempotency part)
- [ ] Job writes are audited with `actor_kind = system`
**Verification:** integration test with pg-boss against the test DB · **Dependencies:** T22 · **Files:** src/modules/clock/{domain/job-catalogue.ts,service/job-runner.ts,db/job-run-schema.ts}, db/migrations/0008_job_runs.sql · **Scope:** M

### - [ ] T24: `clock.advance` (owner, step-up, audited) + demo control
**Description:** `advance({ to } | { byDays })`: compute all job instants and registered scripted-event instants (hook interface for the `simulation` module) between now and target; for each in order set `sim_now` and run synchronously to completion; idempotent via T23. Owner-only, sensitive (step-up) — checked in the server action in `src/app`, not inside `clock`; audit event with from/to via the `sim_clock` trigger. Minimal "Avancer à" control in the sim badge.
**Acceptance criteria:**
- [ ] D1 07:00 → D4 07:00 runs each daily job once per crossed day, chronologically; re-advancing over run instants runs nothing (AC-CLK-03)
- [ ] Advance 3 days ≡ 3 × 1 day: identical job-run sequence and audit sequence (excluding real timestamps) (AC-CLK-04)
- [ ] Requires owner + TOTP ≤ 10 min; each advance audited with from/to (AC-CLK-06)
**Verification:** integration (equivalence test) + e2e owner advance with step-up · **Dependencies:** T23, T12 · **Files:** src/modules/clock/{service/advance.ts,domain/instants.ts,ui/advance-control.tsx}, tests · **Scope:** M

### Checkpoint CP6 — `platform-security` + `clock` done
- [ ] All AC-SEC-01…14 green (AC-SEC-05 mechanism only; AC-SEC-07 financial-table part pending ledger) and all AC-CLK-01…07 green
- [ ] `pnpm test -- --coverage` ≥ 90% on `modules/*/domain` (🟡 A6)
- [ ] Code review (`/agent-skills:review`) + security-auditor pass on the module
- [ ] Review with Ali; then spec → plan for `master-data`
