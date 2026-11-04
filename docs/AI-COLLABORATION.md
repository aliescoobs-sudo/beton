# BELGOBETON — AI collaboration

Updated: 2026-11-04 (end of Batch C). No secrets in this file.

## Roles
- **Ali** decides. Nothing is final until he confirms it.
- **Lead conversation** (Claude, claude.ai) plans, writes the prompts and reviews the checkpoints.
- **Claude Code** builds on `main` in `~/BELGOBETON` (migrations 0078 to 0199; used up to 0104).
- **Codex** builds finance in `/Users/macplanet/BELGOBETON-finance` on branch `codex/finance` (migrations 0200 and above, never merged into main) and does the independent reviews.
- `CLAUDE.md` overrides everything.

## Active tasks
| Task | Owner | Status |
|---|---|---|
| Batch A (R1 to R4, R9, A12) | Claude Code | done, 149 e2e passing |
| Batch B (§16.1 to §16.5, §16.8, §16.9, R5 to R8, R10, some gaps) | Claude Code | done, see CP-PROD-PLAN "Batch B end report" |
| Batch C (C0 to C3) | Claude Code | done, see CP-PROD-PLAN "Batch C end report" |
| Finance module (§10, §3.8) | Codex | merged into main on 2026-11-04, flag off; Codex review of the merge pending |
| Independent review of final main | Codex | after Batch B |
| Plant and driver interviews | Ali | Tue 3 Nov, will amend §6 and §7 |
| Hosting choice, CNDP draft | Lead | pending |

## Last handoff of each side
- **Claude Code → lead:** Batch C end report in `docs/checkpoints/CP-PROD-PLAN.md`; not started: §16.10, day-close fuel and cash lines, office join.
- **Lead → Claude Code:** Batch B prompt (this batch), including REQUIREMENTS-V1 §16 from Codex's review.
- **Codex → lead:** the §16 review, accepted 2 Nov.

## Next step
Lead reviews Batch B; decide on §16.6, §16.7, §16.10 and the open Batch A gaps; Darija wording to be read by a Darija speaker; then Codex reviews main.
