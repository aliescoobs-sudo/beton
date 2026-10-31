# CP-ASSIST-1: the assistant v1

Plan written 2026-10-26, before any code. Spec: [SPEC-assistant.md](../SPEC-assistant.md) (AC-ASSIST-01 to 30; 19 to 30 are the v1.1 additions of this checkpoint, Ali, provisional until the owner confirms). Parent: [SPEC-ai-layer.md](../../SPEC-ai-layer.md). Starting point: [CP-INTEGRATION-2.md](CP-INTEGRATION-2.md). The security rules of CLAUDE.md override everything here: no weakening of RBAC, RLS, 2FA, audit or encryption; money by deterministic code only; no AI action without a human confirmation; pseudonymization before any model call; fake data only.

## Method
One task per commit. Each commit runs lint (eslint + prettier), typecheck, unit and integration tests, the production build and the e2e specs of its own screens. Unit tests first for the pure parts (pre-pass, placeholders, post-check, provider guard, fixtures); integration tests for RLS, the role matrix, allow-lists, refusals, audit and the confirmation; e2e for the panel. fr and ar messages with key parity. The flag is off by default and every task keeps it so; tests and the e2e server switch it on for themselves only.

## Tasks and checklist
Status: `[ ]` to do, `[x]` done, `[~]` partial.

- [x] A0 SPEC changes (v1.1) and this plan (documents only)
- [x] A1 Switches and provider: env (`ASSISTANT_ENABLED`, `ASSISTANT_PROVIDER`, `ANTHROPIC_API_KEY`), start-up refusals, `LlmProvider`, `FakeProvider`, the Anthropic adapter behind its four conditions, the key never in the repository, the build or the client (AC-ASSIST-01 part, 02, 26, 27)
- [x] A2 The pure core: pre-pass (phones, ICE, numbers, amounts, known names to codes), placeholders and re-hydration, leak scan, numbers post-check, injection hardening of data blocks (AC-ASSIST-05 to 08 at unit level)
- [x] A3 Tables and the assistant module: `ai_interaction`, `ai_tool_call`, `ai_proposal` (migration, RLS, audit, encrypted payloads, 90-day purge), the `ai_confirmed` audit kind, permission `assistant.use`, rate limits and budget (AC-ASSIST-14, 15)
- [x] A4 Read tools, first six (deliveries_today, stock_and_cover, uninvoiced_bls, open_invoices, forecast, next_load): matrix, allow-lists, refusals, exposure test (AC-ASSIST-03, 04)
- [x] A5 Read tools, four new (order_chain, find_document, purchase_status, consumption_variance) (AC-ASSIST-21 to 25)
- [x] A6 The turn: orchestrator over provider, tools, pre-pass, post-check, fallback, audit; injection fixtures (AC-ASSIST-01, 05 to 09, 14, 15)
- [x] A7 Drafts and confirmation: plan_order, record_payment, create_purchase, record_return, invoice_from_bls; proposals; confirm with step-up and the human as actor (AC-ASSIST-10 to 13, 16, 19, 20)
- [x] A8 The panel: top-bar button on every screen, suggested questions per role, tool chips, "what was sent to the AI", draft cards; fr and ar, 375 and 1280 px; e2e (AC-ASSIST-17, 28, 29)
- [x] A9 Fixture set: 20 questions per role, French and Darija, replayed by the Fake provider (AC-ASSIST-18)
- [x] A10 Finish: `db:scenario` assistant walk per role and DEMO.md (AC-ASSIST-30)
- [x] A11 Full regression on an idle machine, one worker, no timeout raised; AC-ASSIST re-run table; unfinished list and new provisional decisions

## Order and dependencies
```
A1 ─ A2 ─ A3 ─ A4 ─ A5 ─ A6 ─ A7 ─ A8 ─ A9 ─ A10 ─ A11
              (A4, A5 need A2 for allow-list and placeholders; A6 needs A1 to A5; A7 needs A3 and A6)
```

## Risks
| Risk | Impact | Mitigation |
|---|---|---|
| A tool returns more than the screen shows | High | each tool builds its output from a declared allow-list, never from a service row; the exposure test runs every tool for every role; the money keys are placeholders before the model sees them |
| A name or number reaches the provider | High | pre-pass, then a leak scan over every outbound payload against all entity names, phones and ICE; a hit blocks the call; the "what was sent" view shows the same bytes |
| The model states a number it made up | High | post-check against the tool results of the turn; one retry; then the tool results without prose |
| A draft writes before a human confirms | High | a draft only inserts `ai_*` rows; property test counts the rows of every other table; confirmation is the only caller of a service |
| Step-up skipped by the assistant path | High | confirmation goes through `withStepUp('ai.confirm_command')`; test with a stale second factor for each money action and each role |
| The audit trail cannot tell the AI path | Med | `app.ai_proposal_id` in the request context, `audit.append` writes `actor_kind = ai_confirmed` and the proposal id in the request id |
| The real provider or its key leak out | High | adapter built only under four conditions; key only in `.env.local`; repository and build grep test; scrubbed from logs; not a public variable |
| A prompt-injection in stored text drives a tool | High | data blocks, fixed tool list per role, role check at call time, injection fixtures |
| Scope: ten tasks | Med | one commit per task; this table is updated at each commit |

## Acceptance re-run
Run of 2026-10-31, idle machine kept awake (`caffeinate`), Colima and Postgres up, nothing else running. Logs in `.logs/` (git-ignored).

| Step | Result |
|---|---|
| lint (eslint + prettier) | pass, 0 warnings (`.logs/lint.log`) |
| typecheck | pass |
| unit + integration (vitest) | 218 files, 3442 tests, all pass, twice in a row (`.logs/test1.log`, `test2.log`) |
| build (`SIMULATION_ENABLED=false NEXT_DIST_DIR=.next-e2e`) | pass (`.logs/build.log`) |
| e2e, one worker, timeouts as in the repository (120 s per test) | **140 passed, 2 skipped, 0 failed, 30.5 min** (`.logs/e2e-final.log`); the 2 skipped are `design-screenshots` (opt-in, `UI_SCREENSHOTS=1`) |
| dispatch overdue-order spec (AC-INT-22) | pass (29.8 s) |

| AC | Result | Proved by |
|---|---|---|
| 01 flag off: no entry, 404, no provider call, no network | pass | `tests/assistant-turn.int.test.ts`, `tests/assistant-endpoints.int.test.ts`; e2e `assistant.spec.ts` "with the flag off" |
| 02 refuses to start with the flag on and real data / production | pass | `src/lib/env.test.ts` |
| 03 tool list = matrix; a call outside it is refused and audited | pass | `tests/assistant-tools.int.test.ts`, `tests/assistant-turn.int.test.ts` |
| 04 tools run in the user's RLS context; exposure test on outputs | pass | `tests/assistant-tools.int.test.ts` |
| 05 no name, number or amount in any outbound payload | pass | `src/modules/assistant/domain/leak-scan.test.ts`, `pseudonymizer.test.ts`; `tests/assistant-turn.int.test.ts` |
| 06 a name through a bypass is blocked, `blocked_leak` | pass | `leak-scan.test.ts`; `tests/assistant-turn.int.test.ts`, `tests/assistant-leak-index.int.test.ts` |
| 07 an invented number: rejected, one retry, then the tool results | pass | `numbers-check.test.ts`; `tests/assistant-turn.int.test.ts` |
| 08 placeholders put back from tool results; DOM amount = stored centimes | pass | `pseudonymizer.test.ts`; `tests/assistant-turn.int.test.ts`; e2e owner spec (amounts equal the stored ones) |
| 09 injection fixtures: no tool outside the list, no state change | pass | `data-block.test.ts`; `tests/assistant-turn.int.test.ts`, `tests/assistant-drafts.int.test.ts` |
| 10 a draft writes to no business table | pass | `tests/assistant-drafts.int.test.ts` (row counts over the five draft tools) |
| 11 confirmation = the form's service, human as actor, `ai_confirmed`; twice / other user / expired / stale fail closed | pass | `tests/assistant-drafts.int.test.ts`, `tests/assistant-store.int.test.ts` |
| 12 step-up under 10 minutes for money drafts, office included | pass | `tests/assistant-drafts.int.test.ts`, `tests/assistant-endpoints.int.test.ts` |
| 13 office sees no price; confirmed record = the form's | pass | `tests/assistant-drafts.int.test.ts`; e2e office spec |
| 14 every question, call and confirmation audited; purge keeps the chain verifiable | pass | `tests/assistant-turn.int.test.ts`; `tests/assistant-store.int.test.ts` (purge, then `verifyChain` ok) |
| 15 rate limits and budget: no provider call beyond, audited, message in the language | pass | `tests/assistant-turn.int.test.ts`, `tests/assistant-store.int.test.ts` |
| 16 no model-computed total in any tool or proposal schema | pass | `tests/assistant-drafts.int.test.ts` |
| 17 fr and ar, 375 and 1280 px, no CSP violation, no money for roles without it | pass | e2e `assistant.spec.ts` (plant, office in Arabic, partner, support) |
| 18 20 questions per role, right tool and arguments | pass | `src/modules/assistant/fake/fixtures.test.ts` (20 of 20, our own phrasings; the real-provider evaluation is not run, see Not finished) |
| 19 office's tool list is exactly its column; money drafts need the step-up | pass | `tests/assistant-drafts.int.test.ts`; e2e office spec |
| 20 `invoice_from_bls` for owner and office (blind), same invoice as the queue | pass | `tests/assistant-drafts.int.test.ts`; e2e office and owner specs |
| 21 `order_chain` | pass | `tests/assistant-tools-more.int.test.ts` |
| 22 `find_document` | pass | `tests/assistant-tools-more.int.test.ts` |
| 23 `purchase_status` | pass | `tests/assistant-tools-more.int.test.ts` |
| 24 `consumption_variance` | pass | `tests/assistant-tools-more.int.test.ts` |
| 25 matrix row, allow-list and refusal for the four new tools | pass | `tests/assistant-tools-more.int.test.ts` |
| 26 provider default `fake`; the Anthropic adapter only under four conditions | pass | `src/lib/env.test.ts`, `src/lib/ai/anthropic-provider.test.ts` |
| 27 the key never in repository, build, logs or client | pass | `src/lib/ai/key-secrecy.test.ts`, `anthropic-provider.test.ts`; the narrowed build scan was checked by planting a key in the build output (caught) and removing it (clean) |
| 28 top-bar button, panel, chips, "what was sent" | pass | e2e `assistant.spec.ts` |
| 29 draft cards: Confirmer / Refuser, step-up dialog, result by visibility | pass | e2e `assistant.spec.ts` (office and owner) |
| 30 `db:scenario` walk per role, idempotent, audited; DEMO.md | pass | `tests/assistant-walk.int.test.ts` |

### What the regression run found and fixed (A11)
- **Arabic top bar overflowed at 360 px**: the assistant button and the bar's gaps are now compact on a phone.
- **The walk collided with the shared database**: a fixed cheque number was reused across runs, and the question "which BLs are not invoiced" took the whole queue, where a fixture label of another test (`fxmatrix_<uuid hex>`) can hold six digits in a row, which the leak rule stops by design (a run of six digits is a number). The cheque number is random and the walk asks about its own client. Not a product defect: a real product label is not a random hex string.
- **The build scan of the key test** read the compiler cache; it now reads the served file types and skips `cache`.
- **The owner e2e reused a TOTP window**; the spec now records the step it used.

### The earlier run (`.logs/final-3.log`, 6.7 h, 29 failed, 30 not run)
Not used as evidence. On this clean run every spec passes with the same timeouts, so nothing in the code explains that run. The cause was not established by this session: the logs of that run show Postgres connections ended by the administrator (57P01) and TOTP waits, which fits a stopped Colima or a sleeping Mac, but the same four 57P01 lines also appear at the start of this clean run (the e2e database is re-created while the server starts), so they alone prove nothing. One environmental fault was found and fixed here: the Playwright browser cache was missing (`playwright install chromium`, a first attempt failed all 140 tests in 27 s at browser launch, `.logs/e2e-final-nobrowser.log`).

## New provisional decisions
DECISIONS 114 to 120 (all Ali, provisional until the owner confirms): 114 the switches, provider and key; 115 office has the assistant and the step-up on every money draft; 116 tools, allow-lists, units and the numbers rule; 117 drafts (references for amounts, rehearsal, atomic confirmation); 118 names, numbers and the leak scan; 119 limits, switches, budget, retention; 120 the scripted provider and its evaluation set. The v1.1 criteria AC-ASSIST-19 to 30 stay provisional with them. No decision was added by A11.

## Not finished
- **The real-provider evaluation** (`pnpm ai:eval`, D50) does not exist yet and has not been run; AC-ASSIST-18 is proved with the scripted provider on our own phrasings only. It must be done, with the owner's real phrasings, before the real provider is ever switched on.
- **CNDP authorization** is not recorded: the flag cannot be on with real data or in production (AC-ASSIST-02 keeps it so).
- **Owner confirmation** of DECISIONS 114 to 120 and of AC-ASSIST-19 to 30.
- **Site names are not mapped to codes** by the pre-pass: a draft names a site by `SITE-<client>-<n>`; a site named in words is caught by the leak scan and stops the turn (D117).
- **The number post-check is on the number, not on the unit** (D116).
- **No stored budget alert** (the panel warns the owner from 80 %); the cost constants are provisional (D119).
- **The 90-day purge is not scheduled** (`assistant:purge` is a script; the jobs are stubs).
- **No recette tool** in v1 (D120).
- **Leak rule false positives** fail closed by design (D118); in tests they come from random fixture labels, which is why the walk asks about its own client.
- **`design-screenshots` e2e** is opt-in and was not run (2 skipped).
- **Not run:** `audit:verify` against the dev database and `db:scenario` on a real dev database; the audit chain is verified inside the integration tests only.
