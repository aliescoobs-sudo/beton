# BELGOBETON — AI collaboration

Updated: 2026-11-02 (start of Batch B). No secrets in this file.

## Roles
- **Ali** decides. Nothing is final until he confirms it.
- **Lead conversation** (Claude, claude.ai) plans, writes the prompts and reviews the checkpoints.
- **Claude Code** builds on `main` in `~/BELGOBETON` (migrations 0078 to 0199).
- **Codex** builds finance in `/Users/macplanet/BELGOBETON-finance` on branch `codex/finance` (migrations 0200 and above, never merged into main) and does the independent reviews.
- `CLAUDE.md` overrides everything.

## Active tasks
| Task | Owner | Status |
|---|---|---|
| Batch A (R1 to R4, R9, A12) | Claude Code | done, 149 e2e passing |
| Batch B (§16, R5 to R8, R10, gaps) | Claude Code | in progress, one commit per task |
| Finance module (§10, §3.8) | Codex | in progress in the finance worktree |
| Independent review of final main | Codex | after Batch B |
| Plant and driver interviews | Ali | Tue 3 Nov, will amend §6 and §7 |
| Hosting choice, CNDP draft | Lead | pending |

## Last handoff of each side
- **Claude Code → lead:** end of Batch A report in `docs/checkpoints/CP-PROD-PLAN.md` ("Not finished").
- **Lead → Claude Code:** Batch B prompt (this batch), including REQUIREMENTS-V1 §16 from Codex's review.
- **Codex → lead:** the §16 review, accepted 2 Nov.

## Next step
Finish Batch B, run the full e2e once, update CP-PROD-PLAN.md, then the lead reviews and Codex reviews main.
