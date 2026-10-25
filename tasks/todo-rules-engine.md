# Task list: `rules-engine` + `owner-dashboard`

Plan: [tasks/plan-rules-engine.md](plan-rules-engine.md). Standard verification for every task: `pnpm lint && pnpm typecheck && pnpm test:unit` (+ `pnpm test:integration <name>` when it touches the DB, `pnpm exec playwright test <spec>` for screens). The dev server on :3000 is never started or stopped by me; e2e runs on :3100 against its own database.

## Phase A: Domain (pure)
- [x] R1 working days, cash flows, forecast base + worst (AC-RE-02, 04, 14)
- [x] R2 lowest day, black day, severity, causes; the rules catalogue (AC-RE-03, 05, 06, 13)
- [x] R3 alert state: fold of events, reclassify, override dropped when it worsens (AC-RE-07, 08)
- [x] R4 what-if and options: generator, coverage, ranking, pairs (AC-RE-09, 10)
- [x] R5 stock risk from the recette in force, expected receipts, purchase draft

## Phase B: Persistence and services
- [x] R6 migration `alert`, `alert_event`, `cash_decision`; parameters; step-up action `cash.apply_option`; table-access + RLS matrix
- [x] R7 services: snapshot (money, stock), run, sync alerts, reclassify, apply option, role views

## Phase C: Screens and demo
- [x] R8 "Aujourd'hui" (owner/support), alert report with options and what-if, non-money today, chart, fr + ar
- [x] R9 scenario: a black day in the horizon on the dev data (`db:scenario`, no reset)
- [x] R10 e2e, coverage gate, boundary map, checkpoint note, DEMO.md
