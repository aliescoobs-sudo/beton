# Implementation Plan: `platform-security` + `clock`

Status: **APPROVED** (2026-10-18) · Date: 2026-10-18
Specs: [SPEC-platform-security.md](../SPEC-platform-security.md), [SPEC-clock.md](../SPEC-clock.md), shared rules in [CAPABILITY-MAP.md](../CAPABILITY-MAP.md).
Task list: [tasks/todo.md](todo.md) (task details, acceptance criteria, verification).

## Overview
First build step of the map (`platform-security`, `clock` → …). The repo is empty except docs/specs, so this plan starts with the project scaffold. Security comes first: the database roles, audit log and RLS context exist before any login; authentication and 2FA come before any business screen; the simulated clock comes last. It needs owner-only, step-up-protected, audited actions, so it depends on the security pieces.

## Architecture decisions (for review)
1. **Clock in real mode first, simulated mode last.** `clock.now()` + the `Date.now()` lint ban land in Phase 0 so that every later file is written against the clock (sessions, audit `sim_at`, rate limits). The simulated mode and `advance` come in Phase 5.
2. **Four PostgreSQL roles:** `migrator` (owns schema, runs migrations), `app` (business tables, RLS forced, no `BYPASSRLS`, no `DELETE` on financial tables, no `UPDATE/DELETE` on `audit_event`), `auth` (only the auth tables: credentials, sessions, login attempts; the `app` role cannot read credentials), `system` (jobs, explicit minimal grants). Separating `auth` keeps password hashes and TOTP secrets out of reach of the general app role.
3. **RLS context = one helper.** `withRlsContext({ userId, role, requestId, simAt }, fn)` opens a transaction and calls `set_config(..., true)` (transaction-local). It is the only way services touch the DB; a test proves the settings never leak across pooled connections.
4. **Audit = DB trigger + hash chain.** A generic trigger function attached to every business table; a missing `app.user_id` aborts the write. The hash chain is computed in the trigger under an advisory lock. Built and tested on a test-only `audit_probe` table before any real table exists.
5. **Better Auth is checked in a spike task (T8) with a go/no-go gate** (🟡 A1). Requirements it must meet: argon2id (via `@node-rs/argon2`), `__Host-` cookie, idle 30 min / absolute 12 h, rotation on login and 2FA, server-side revoke, TOTP + recovery codes, runs on the `auth` DB role, hookable for audit events. If any fails → fallback: hand-rolled argon2id + `otplib` + our own session table (same task list after T8, different internals). Result recorded as `docs/adr/0001-auth-library.md`.
6. **Spec table names are logical.** If Better Auth is kept, its tables (user/session/account/twoFactor) are mapped to the spec's `app_user`/`session`/`credential` through the Drizzle adapter. `app_user` gets extra fields (role, locale, status).
7. **No seed or default accounts.** The first owner is created by a CLI command (`pnpm user:create-owner`) that prompts for email and password, forces TOTP enrolment at first login, and is audited as actor `system/bootstrap`. All other users are created by the owner in the app.
8. **Permissions as data in code.** `src/modules/platform-security/domain/permissions.ts` encodes the SPEC §4 matrix. The route guards, the service guards and the generated RLS test matrix all read from this one file, so the tests always check the same rules the code enforces. A meta-test fails if any table lacks `FORCE ROW LEVEL SECURITY` or a matrix entry; later modules can't skip it.
9. **Field-level hiding (AC-SEC-05)** gets its mechanism here: role-scoped projections plus a test helper `expectNoFields(...)`. The AC itself is closed by master-data, ledger and operations, because the fields it names (prices, margins) don't exist yet.
10. **Simulated jobs run in-process, real jobs run via pg-boss.** During `clock.advance`, due jobs run synchronously in chronological order, for determinism (AC-CLK-04). In real mode pg-boss cron triggers the same job handlers. `scheduled_job_run (job_key, business_date)` uniqueness makes both paths idempotent.

## Dependency graph

```
T1 scaffold ─┬─ T2 env + logger
             └─ T3 clock (real) + lint ban
T2,T3 ── T4 DB roles + RLS context helper + test harness
T4 ── T5 audit table immutable ── T6 audit capture trigger ── T7 hash chain + audit:verify
T4,T7 ── T8 auth spike (gate) ── T9 owner bootstrap + password login + lockout
                                  └─ T10 TOTP enrolment + recovery codes ── T11 session lifetimes + logout
                                                                             └─ T12 step-up guard
T12 ── T13 permission matrix + guards + user admin ── T14 RLS policies + generated matrix test ── T15 field-hiding helper
T4 ── T16 field encryption (T10 uses it for TOTP secrets if lib doesn't) 
T1 ── T17 security headers + CSP
T7 ── T18 backup + restore test
T13,T14 ── T19 parameters store ── T20 audit viewer ── T21 security checklist + fake-data banner
T19,T14 ── T22 simulated clock + boot guards ── T23 job runner ── T24 clock.advance (owner, step-up, audited)
```

Parallelizable after Checkpoint 2: T16, T17, T18 are independent of the auth chain (T8–T12).

## Phases and checkpoints
| Phase | Tasks | Checkpoint |
|---|---|---|
| 0 Foundation | T1–T4 | CP1: lint/typecheck/test/build green; `/fr` + `/ar` render; app role verified non-privileged |
| 1 Audit | T5–T7 | CP2: AC-SEC-06/07/08 green on probe table; `pnpm audit:verify` works |
| 2 Identity | T8–T12 | CP3: Playwright login + enrolment + step-up in fr and ar; ADR 0001 accepted |
| 3 Authorization | T13–T15 | CP4: AC-SEC-04 matrix green for all existing tables; AC-SEC-14 |
| 4 Data protection & ops | T16–T21 | CP5: AC-SEC-10/12/13; parameters + audit viewer + checklist banner |
| 5 Clock simulation | T22–T24 | CP6 (module done): all AC-SEC (05 mechanism only) + all AC-CLK green; security review (`/agent-skills:review` + security-auditor) before starting `master-data` |

## Acceptance-criteria coverage

| AC | Task(s) |
|---|---|
| AC-SEC-01 | T10 |
| AC-SEC-02 | T9, T10 |
| AC-SEC-03 | T11 |
| AC-SEC-04 | T14 (+ every later module adds its tables) |
| AC-SEC-05 | T15 mechanism; closed in master-data / ledger / operations |
| AC-SEC-06 | T6 |
| AC-SEC-07 | T5 (audit part); financial-table DELETE part closed in ledger |
| AC-SEC-08 | T6, T7, T22 (sim_at) |
| AC-SEC-09 | T12 |
| AC-SEC-10 | T16 |
| AC-SEC-11 | T2 |
| AC-SEC-12 | T18 |
| AC-SEC-13 | T17 |
| AC-SEC-14 | T13 |
| AC-CLK-01 | T3 (real), T22 (sim disabled ⇒ no advance) |
| AC-CLK-02 | T22 |
| AC-CLK-03 | T23, T24 |
| AC-CLK-04 | T24 |
| AC-CLK-05 | T22 |
| AC-CLK-06 | T24 |
| AC-CLK-07 | T3 |

## Risks and mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| Better Auth can't meet session/argon2/role-separation requirements | High | T8 spike with explicit gate before any login code; documented fallback |
| RLS settings leak across pooled connections (session-level `set_config`) | High | Only transaction-local `set_config(..., true)`; dedicated leak test in T4 |
| Audit hash chain serializes writes (advisory lock) → contention | Med | Acceptable at pilot scale (5 users); measure in T7 (100 parallel inserts < 2 s); fallback = chain computed by a background sealer |
| Trigger-based audit misses tables added later | High | T14 meta-test fails if a business table lacks the audit trigger or RLS |
| Fake timers vs real clock for session tests | Low | All expiry logic reads `clock.now()`; tests inject a controllable clock |
| Scaffold touches > 5 files | Low | Accepted exception for T1 (generated boilerplate); reviewed as one unit |
| CSP nonces vs Next.js streaming/inline scripts | Med | T17 uses Next's documented nonce pattern via middleware; e2e checks no CSP violations in console |
| `age` CLI not installed on dev machine / host | Low | T18 checks the binary at start and fails with an install hint; documented in README |

## Resolved questions (Ali, 2026-10-18)
1. Password hashing: argon2id via `@node-rs/argon2` (spec unchanged).
2. Bundle a public top-10k common-password list (SecLists, MIT) with its licence notice kept alongside the file.
3. Add `eslint-plugin-boundaries` in T1 (🟡 A20 → ✅).
4. CI stays local (`pnpm ci:local`) for now; the GitHub Actions workflow is added later, once a private remote exists.
5. Postgres driver: `pg` (node-postgres).
6. First owner via CLI (`pnpm user:create-owner`); no setup page.
