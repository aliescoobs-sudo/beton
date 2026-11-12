# KAYAS staging on a rented VPS — runbook (T10g)

**Status: draft of group A; completed at the end of T10g.** Nothing here has been run on a VPS. The configuration was proven on a local rehearsal (`scripts/staging/rehearse.sh`, evidence in `docs/checkpoints/CP-STAGING.md`). Codex's R20 verification comes before the owner deploys anything.

Staging is a copy of the app with **fictitious data only**, training mode ON, behind **HTTP Basic Auth on the whole site**. Real data stays forbidden (gates G1–G12 in `docs/REAL-DATA-GATES.md` stay open). **Data policy: staging data is disposable. It is RESET (`scripts/staging/reset.sh`), never restored from a backup, and its volumes are never reused for real data.**

(Sections follow in the final version: host facts, ordered steps, external checks, reboot rehearsal.)
