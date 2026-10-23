# Order entry timing (AC-LED-10)

Measured by `e2e/ledger-order.spec.ts` (office user, one client found by search, type, volume, a 2-item plan from the
"50 % d'avance + 50 % à la livraison" preset, save; no AI): **0.1 s** of scripted entry (no human think time) against the 120 s target.
Re-measure with `ENTRY_TIMING=1 pnpm exec playwright test e2e/ledger-order.spec.ts`.
