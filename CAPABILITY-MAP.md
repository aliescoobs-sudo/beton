# Capability Map — BELGOBETON MVP pilot

Status: **APPROVED (spec phase) — 2026-10-18**, review answers applied · Date: 2026-10-18 · Scope: BRIEF.md §8 only (out-of-scope list in §8 stays out).

This file is the index of the spec. It holds the module map plus everything shared by all modules
(objective, stack, commands, structure, style, testing, boundaries, conventions, assumption register).
Each module has its own `SPEC-<module-id>.md` with data model, behaviour, permissions and acceptance criteria.

Legend (same as DECISIONS.md): ✅ confirmed · 🟡 assumption. `D<n>` = DECISIONS.md item, `R<n>` = DOMAIN.md rule,
`A<n>` = new assumption introduced by this spec (register in §10). Every 🟡 a module relies on is listed in that module's spec.

## 1. Module map

| Module id | Responsibility | Depends on | Spec |
|---|---|---|---|
| `platform-security` | Auth + 2FA, sessions, RBAC (app + PostgreSQL RLS), immutable audit log, encryption, backups, secrets, parameters | `clock` | [SPEC-platform-security.md](SPEC-platform-security.md) |
| `clock` | Single source of "now"; real vs simulated clock; scheduled-job runner driven by the clock | — | [SPEC-clock.md](SPEC-clock.md) |
| `master-data` | Clients, suppliers, components/units, recettes, concrete types, prices, trucks, zones | `platform-security` | [SPEC-master-data.md](SPEC-master-data.md) |
| `ledger` | Orders + payment plans, internal invoices, payment instruments lifecycle, purchases, supplier payments, money accounts, reversing entries | `master-data`, `clock` | [SPEC-ledger.md](SPEC-ledger.md) |
| `operations` | Deliveries (loads/BL), stock movements, margin per delivery, truck capacity | `ledger`, `master-data` | [SPEC-operations.md](SPEC-operations.md) |
| `rules-engine` | Deterministic cash position, forecast, statuses/colours, alert rules, option generator, reclassification | `ledger`, `operations`, `clock` | [SPEC-rules-engine.md](SPEC-rules-engine.md) |
| `reconciliation` | Plant import / manual totals, physical count, three-way gaps, attribution | `operations`, `platform-security` | [SPEC-reconciliation.md](SPEC-reconciliation.md) |
| `simulation` | Fake company dataset, black-day week, demo controls | `rules-engine`, `reconciliation`, `clock` | [SPEC-simulation.md](SPEC-simulation.md) |
| `notifications` | In-app inbox, web push, minimal Telegram | `rules-engine` | [SPEC-notifications.md](SPEC-notifications.md) |
| `owner-dashboard` | Brain's home, forecast view, black-day report; works with AI off | `rules-engine`, `reconciliation`, `notifications` | [SPEC-owner-dashboard.md](SPEC-owner-dashboard.md) |
| `ai-layer` | Provider abstraction, pseudonymization, 5 AI roles, confirmation flow, kill switches, budget | `rules-engine`, `reconciliation`, `ledger`, `owner-dashboard` | [SPEC-ai-layer.md](SPEC-ai-layer.md) |
| `assistant` | The in-app assistant: tool calling over the services under the caller's RLS, drafts confirmed by a human, pseudonymization, post-check of numbers, audit | `platform-security`, `master-data`, `ledger`, `operations`, `rules-engine`, `clock` | [docs/SPEC-assistant.md](docs/SPEC-assistant.md) |

**Build order:** `clock` (real mode) → `platform-security` → `master-data` → `ledger` → `operations` → `rules-engine`, `reconciliation` → `simulation` → `notifications`, `owner-dashboard` → `ai-layer`

Dependency rule: a module may import only from modules it depends on (directly or transitively). Enforced by lint (`eslint-plugin-boundaries`, ✅ A20 approved 2026-10-18; map mirrored in `module-map.mjs`).

`clock` has no dependencies; `platform-security` depends on it for `clock.now()` (session lifetimes, audit sim time). Owner/step-up checks for `clock.advance` are done in the route layer (`src/app`), and its audit comes from the DB trigger, so `clock` never imports `platform-security` (avoids a cycle; changed 2026-10-18 during T1).

## 2. Objective (shared)

Give an overloaded, often-absent owner of a ready-mix concrete company in Tetouan the awareness he has when present:
every financial and material movement is recorded with who/when/what, today's state is known, the coming 14 days are
projected deterministically, conflicts are detected ≥ 2 days ahead, explained, and resolved in conversation — with
human confirmation for every action.

Users: owner, partner, 2 office staff, plant operator (✅ D2). Pilot = fake data only (🟡 D37).

**Pilot success criteria (BRIEF §6), made testable:**

| # | Criterion | Verified by |
|---|---|---|
| S1 | In the simulated week, the black day (D5) is flagged 🔴 no later than D3 07:00 sim time (2 days ahead), with a report listing every cause and 2–3 ranked options with computed impact | `e2e/black-day.spec.ts` + AC-SIM-*, AC-DASH-* |
| S2 | An office user enters a standard order (client, type, m³, date, site, price, payment plan) in < 60 s median with AI-assisted entry, and < 120 s without AI | Timed usability script (5 runs, `docs/pilot/entry-timing.md`) + AC-AI-* |
| S3 | End-of-day reconciliation shows every planned ↔ plant ↔ BL ↔ count gap above tolerance, with the most likely source and the linked entries/people | AC-REC-* |
| S4 | 100% of business-table changes produce an audit event with actor + real time (+ sim time); audit chain verifies | AC-SEC-* |

## 3. Tech stack (✅ chosen 2026-10-18 by Ali, replaces 🟡 D43 "final choice in spec")

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript (strict) | `"strict": true`, `noUncheckedIndexedAccess` |
| Runtime | Node.js 24 LTS | pinned in `.nvmrc` + `engines` |
| Web | Next.js (App Router, current stable at setup, pinned exact) | Server Components + Server Actions; PWA manifest + service worker (🟡 D41) |
| DB | PostgreSQL 17 with Row-Level Security | app connects as non-owner role without `BYPASSRLS` |
| Database access / migrations | `pg` + hand-written SQL migrations; Drizzle only as the migration runner | ✅ DECISIONS 43: SQL-first, no Drizzle table schemas |
| Jobs | pg-boss (Postgres-backed queue/scheduler) | no Redis; schedules are driven through `clock` |
| Auth | Better Auth 1.7.7 (pinned exactly) + two-factor (TOTP) plugin, `@node-rs/argon2`, `@better-auth/utils` 0.4.2 (✅ CP3) | ✅ A1 (ADR 0001, 2026-10-18); every upgrade re-runs the full auth test suite |
| Validation | Zod at every boundary (forms, server actions, imports, AI output, webhooks) | |
| i18n | next-intl, locales `fr` + `ar`, RTL for `ar` | ✅ both languages in pilot (2026-10-18); Darija accepted as AI input |
| UI | Tailwind CSS (logical properties only: `ms-`/`me-`/`ps-`… for RTL), Radix-based components | |
| Charts | Lightweight SVG chart lib (chosen at plan time, ask first) | forecast chart |
| QR codes | `uqr` 0.1.3 (UnJS, MIT, no dependencies), rendered server-side | ✅ CP3 (DECISIONS 73): enrolment QR; secret never sent to an external service |
| Telegram | grammY, webhook mode | |
| AI | `ai-layer` provider interface; adapters: Anthropic (Haiku 5.5 / Sonnet 5.5), Mistral, Fake | 🟡 D50 |
| Tests | Vitest, fast-check (property tests), Playwright, Testcontainers or compose test DB | |
| Infra (pilot) | docker-compose: `app`, `db`, `mailpit` not needed; local first | ✅ hosting decided later; must stay portable to a Moroccan host (🟡 D52) |
| Package manager | pnpm | 🟡 A2 |

## 4. Commands

```bash
# setup
corepack enable && pnpm install --frozen-lockfile
cp .env.example .env.local            # fill secrets locally; never commit
docker compose up -d db               # PostgreSQL 17 on :5432

# database
pnpm db:migrate                       # apply db/migrations (SQL: tables, RLS, triggers, grants)
pnpm db:seed:sim                      # load simulation dataset (refuses unless SIMULATION_ENABLED=true)
pnpm sim:reset                        # drop + recreate sim database, re-seed (pilot only)

# dev / build
pnpm dev                              # next dev on :3000
pnpm build && pnpm start

# quality
pnpm lint                             # eslint (incl. module boundaries) + prettier --check
pnpm typecheck                        # tsc --noEmit
pnpm test                             # vitest run (unit + integration, needs db)
pnpm test -- --coverage
pnpm test:e2e                         # playwright test (starts app against seeded sim db)
pnpm audit:deps                       # pnpm audit --prod --audit-level=high

# security / ops
pnpm audit:verify                     # verify audit-log hash chain
pnpm backup                           # pg_dump | age -r $BACKUP_AGE_RECIPIENT > backups/<ts>.sql.age
pnpm backup:restore-test              # restore latest backup into scratch db, run integrity checks

# AI (optional, never in CI against real providers)
pnpm ai:eval                          # run eval set (D50) against configured providers; fake data only
```

CI (on every push): `lint`, `typecheck`, `test --coverage`, `test:e2e`, `audit:deps`, `audit:verify` on the test db.

## 5. Project structure

```
src/
  app/[locale]/                Next.js routes (fr, ar); thin — call module services only
  app/api/telegram/webhook/    Telegram webhook route
  modules/<module-id>/
    domain/                    pure functions + types, NO I/O (rules engine logic lives here)
    service/                   use-cases; the only place that opens DB transactions
    db/                        typed SQL queries (repositories) for this module; schema lives in db/migrations
    ui/                        module components
    index.ts                   public surface (other modules import only from here)
  lib/                         money.ts, quantity.ts, ids.ts, result.ts (shared, dependency-free)
db/
  migrations/                  hand-written SQL migrations (tables, RLS, audit triggers, grants)
messages/fr.json, messages/ar.json
fixtures/simulation/           seed dataset + black-day script (fake data only)
e2e/                           Playwright specs
scripts/                       backup, restore-test, audit-verify
docs/                          BRIEF, DECISIONS, DOMAIN, RESEARCH, pilot/
```

Tests are colocated (`*.test.ts` next to the file); DB integration tests are `*.int.test.ts`.

## 6. Code style

Money and quantities are branded integers; every fractional step goes through one rounding function.

```ts
// src/lib/money.ts
export type Centimes = number & { readonly __brand: 'Centimes' };

export function centimes(value: number): Centimes {
  if (!Number.isSafeInteger(value)) throw new RangeError(`Not an integer centime amount: ${value}`);
  return value as Centimes;
}

/** amount × num / den, rounded half away from zero. The only way a fraction becomes money. */
export function mulDivRound(amount: Centimes, num: number, den: number): Centimes {
  const n = BigInt(amount) * BigInt(num);
  const d = BigInt(den);
  const q = n / d;
  const r = n % d;
  const away = (r < 0n ? -r : r) * 2n >= (d < 0n ? -d : d);
  return centimes(Number(away ? q + (n < 0n === d < 0n ? 1n : -1n) : q));
}
```

Domain functions are pure and receive time explicitly:

```ts
// src/modules/rules-engine/domain/forecast.ts
export function forecastCash(input: ForecastInput, today: BusinessDate): ForecastDay[] { /* no I/O, no Date.now() */ }
```

Conventions:
- Files `kebab-case.ts`; types `PascalCase`; functions `camelCase`; DB tables/columns `snake_case`.
- Business vocabulary from DOMAIN.md in identifiers where it is the real term: `recette`, `echeance`, `lcn`, `bl`, `caisse`, `encaisse`.
- `Date.now()` / `new Date()` are banned outside `clock` (lint rule). Business dates are `BusinessDate` (`YYYY-MM-DD`, Africa/Casablanca, 🟡 A3).
- No `any`, no non-null `!` on external data, no floats for money/quantities, no `parseFloat` on amounts.
- Errors: domain returns `Result<T, DomainError>`; services throw only for programmer errors.
- UI strings only via `messages/*.json`; financial terms stay French in both locales where the office uses them (🟡 D48).

## 7. Shared conventions

- **Money (R8):** MAD stored as `bigint` centimes (`Centimes` in TS, safe-integer guarded). Amounts on documents are HT + VAT rate + TTC; VAT rate is a parameter (🟡 A4: default 20%, open question D-OQ7).
- **Quantities:** concrete volume in **litres** (integer; 1 m³ = 1000 L), displayed as m³ with up to 3 decimals. Component quantities in an integer **base unit** per component (g, mL, L…). Purchase units carry an integer conversion factor to the base unit (e.g. `t` = 1 000 000 g, `sac 50 kg` = 50 000 g).
- **Time:** timestamps `timestamptz` (real wall time) + `sim_at` where relevant; business dates `date` in Africa/Casablanca. Working days Mon–Sat, holiday list configurable (🟡 A5).
- **IDs:** UUIDv7 primary keys; human codes for business entities (`CLT-017`, `FRN-03`, `CMD-2026-00123`, `BL-2026-00456`). Codes are also the pseudonyms sent to AI.
- **No hard deletes (R12, 🟡 D34):** financial tables have no `DELETE` grant; corrections are reversing entries (`reverses_id`), master data is archived.
- **Every write** goes through a module service, inside a transaction that sets `app.user_id`, `app.role`, `app.request_id` (RLS + audit).

## 8. Testing strategy (shared)

| Level | Tool | What | Bar |
|---|---|---|---|
| Unit (domain) | Vitest + fast-check | money/quantity math, forecast, rules, option generator, attribution, pseudonymizer | ≥ 90% line + branch coverage on `modules/*/domain` (🟡 A6) |
| Integration | Vitest + real PostgreSQL | services, RLS per role, audit triggers, grants, imports | every table has an RLS test per role (allowed + denied) |
| Contract | Vitest | AI provider adapters vs Fake, Telegram payload builder, plant import mapper | |
| E2E | Playwright (fr + ar) | black-day week, order entry, reconciliation, 2FA login, Telegram link flow (bot mocked) | runs on every CI build |
| Security | scripted | audit chain verify, backup restore test, dependency audit, leak scanner (no entity names in AI/Telegram payloads) | blocking in CI |

Rules: no test hits a real AI provider or real Telegram in CI. Each rule in the rules catalogue (SPEC-rules-engine §4) has ≥ 1 positive and ≥ 1 negative test. Bugs get a failing test first (Prove-It).

## 9. Boundaries (shared)

**Always**
- Read BRIEF/DECISIONS/DOMAIN before work; use DOMAIN vocabulary (m³, never m²).
- Compute money/quantities in deterministic, tested domain code; integers only.
- Go through a service that sets RLS context; write audit events; use reversing entries for corrections.
- Validate all external input with Zod (forms, CSV/XLSX, webhooks, AI output).
- Pseudonymize + minimize before any AI call; run the leak scanner in tests.
- Keep the app fully usable with every AI feature switched off.
- Run `pnpm lint && pnpm typecheck && pnpm test` before every commit.

**Ask first**
- Any DB schema change after the module's first approved migration; any RLS policy or grant change.
- Adding a dependency (the stack table above is pre-approved; anything else asks).
- Changing a rule threshold default, severity mapping, or the rules catalogue.
- Changing what data is sent to AI or Telegram.
- Changing CI, backup, or encryption configuration.
- Updating DECISIONS.md / DOMAIN.md (spec changes that contradict them go there first).

**Never**
- Commit secrets, `.env*`, keys, backups, or real data. Load real data before the D37 security checklist passes.
- Let AI compute amounts, decide, or execute without a human confirmation click.
- Put names, amounts, client/supplier codes, or any financial detail in Telegram or push payloads.
- Hard-delete financial records; disable/bypass RLS, 2FA, or audit triggers (including "temporarily" in tests — use a dedicated test role instead).
- Use floats for money, `Date.now()` outside `clock`, or the AI Batch API (🟡 D51).
- Store CIN numbers (🟡 D57) or cheque images.

## 10. Assumption register (new assumptions introduced by this spec)

Doc-level 🟡 items (D27–D59, R-rules) are cited inline in each module spec. New ones (✅ = answered by Ali on 2026-10-18; others remain 🟡):

| Id | Assumption | Used by |
|---|---|---|
| A1 | ✅ 2026-10-18 (ADR 0001): Better Auth 1.7.7 pinned + TOTP plugin, gaps closed by tested hooks | platform-security |
| A2 | pnpm as package manager | all |
| A3 | ✅ 2026-10-18: time zone Africa/Casablanca from IANA tz data; Morocco is on UTC+0 permanently since 20 Sept 2026 (decree 2.26.530, no Ramadan switch) | all |
| A4 | ✅ 2026-10-18: VAT 20% in the simulation; must be a configurable parameter (`vat_rate_bp`), single rate per line | ledger, rules-engine |
| A5 | Working days Mon–Sat; holidays configurable | clock, operations |
| A6 | Coverage bar 90% on domain code | all |
| A7 | ✅ 2026-10-18: 2FA = TOTP authenticator app + 10 single-use recovery codes stored encrypted with a dedicated env key; no SMS | platform-security |
| A8 | Session: idle timeout 30 min, absolute 12 h; step-up 2FA ≤ 10 min old for sensitive actions | platform-security |
| A9 | ✅ 2026-10-18: office reads all operational records needed to record payments, but no margins, cash position or forecast (nor costs or risk alerts) | platform-security |
| A10 | Partner = owner minus user management, parameters, simulation controls, backups | platform-security |
| A11 | ✅ 2026-10-18: plant operator creates loads (BL) at dispatch; whoever receives the signed BL (plant or office) records its return; double recording is prevented; audit shows who | operations |
| A12 | Recettes and price lists are versioned by effective date, never edited in place | master-data |
| A13 | ✅ 2026-10-18 (consistent with R11): worst case = base case with outgoing post-dated instruments counted as liabilities from their issue date, i.e. dated max(issue date, today) | rules-engine |
| A14 | ✅ 2026-10-18: 🔴 only for deficits in the normal (base) forecast; 🟠 for worst-case-only deficits | rules-engine |
| A15 | ✅ 2026-10-18: overdue receivable *alert* → 🟠; the account *colour* stays 🔴 when an échéance is overdue (R14) | rules-engine |
| A16 | Ranked options come from a fixed deterministic catalogue; AI only explains them | rules-engine, ai-layer |
| A17 | ✅ 2026-10-18: cheque/LCN clearing delay after deposit = 1 working day in the simulation; must be a configurable parameter (`clearing_delay_days`) | rules-engine |
| A18 | Loading time per trip 10 min, working day 600 min (parameters) | operations |
| A19 | Amounts are never sent to AI: replaced by placeholders and re-hydrated by code | ai-layer |
| A20 | ✅ 2026-10-18: `eslint-plugin-boundaries` | all |
| A21 | Simulation reset may drop the *simulation* database (fake data) — the only exception to "no hard deletes" | simulation |
| A22 | Owner Q&A and conversational commands available to owner + partner only in MVP | ai-layer |
| A23 | ✅ 2026-10-18: AI never writes financial records; AI actions limited to alert actions + drafting (never sending) client messages; assisted entry only prefills forms and a human saves | ai-layer |
| A24 | Pilot AI monthly budget cap USD 20, alert at 80% | ai-layer |
| A25 | Telegram: max 1 message per user per 15 min (batched), quiet hours 22:00–07:00 except 🔴 | notifications |
| A26 | Invoice numbering gapless per year; cancellation = credit note (avoir) | ledger |
| A27 | ✅ 2026-10-18: per-client selling-price overrides allowed; owner and partner only, mandatory reason | master-data, ledger |

## 11. Open questions (blocking for production, not for pilot)

Inherited from DECISIONS.md: OQ1 revenue/69-21 obligations, OQ2 e-invoicing date, OQ3 plant export format, OQ4 CNDP AI transfer, OQ5 AI provider + ZDR, OQ6 real truck/zone data, OQ7 VAT, OQ8 Moroccan host (must provide a reverse proxy setting `X-Forwarded-For` for the per-IP login limit), OQ9 opening balances, OQ10 partner permissions.

Resolved on 2026-10-18 (were Q1–Q4): Q1 → A9 ✅ · Q2 → A11 ✅ · Q3 → A27 ✅ · Q4 → A14 ✅.
