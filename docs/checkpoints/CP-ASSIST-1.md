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
- [ ] A4 Read tools, first six (deliveries_today, stock_and_cover, uninvoiced_bls, open_invoices, forecast, next_load): matrix, allow-lists, refusals, exposure test (AC-ASSIST-03, 04)
- [ ] A5 Read tools, four new (order_chain, find_document, purchase_status, consumption_variance) (AC-ASSIST-21 to 25)
- [ ] A6 The turn: orchestrator over provider, tools, pre-pass, post-check, fallback, audit; injection fixtures (AC-ASSIST-01, 05 to 09, 14, 15)
- [ ] A7 Drafts and confirmation: plan_order, record_payment, create_purchase, record_return, invoice_from_bls; proposals; confirm with step-up and the human as actor (AC-ASSIST-10 to 13, 16, 19, 20)
- [ ] A8 The panel: top-bar button on every screen, suggested questions per role, tool chips, "what was sent to the AI", draft cards; fr and ar, 375 and 1280 px; e2e (AC-ASSIST-17, 28, 29)
- [ ] A9 Fixture set: 20 questions per role, French and Darija, replayed by the Fake provider (AC-ASSIST-18)
- [ ] A10 Finish: `db:scenario` assistant walk per role and DEMO.md (AC-ASSIST-30)
- [ ] A11 Full regression on an idle machine, one worker, no timeout raised; AC-ASSIST re-run table; unfinished list and new provisional decisions

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
Filled in at A11.

## New provisional decisions
Filled in at A11 (DECISIONS 114 and following).
