# BELGOBETON — Lead handoff (for a new lead conversation)

Last update: 2 Nov 2026, 07:15. This file is kept up to date by the lead conversation at every milestone. A new lead conversation (for example on Ali's second Claude account) starts by reading this file, then the files it points to.

## Who and how
- **Ali** owns the project and decides everything. He speaks Moroccan Darija. Answer him in Darija with technical terms in English.
- Prompts for Claude Code and Codex are written in English. Codex can also be addressed in Darija.
- Ali's wife may relay messages and screenshots. Decisions, 2FA codes and passwords stay with Ali.
- **Claude Code** runs on Ali's Mac in `~/BELGOBETON` with `claude --model sonnet`. Never `sonnet.` with a dot.
  - Keep the Mac awake with `caffeinate -dims` in its own Terminal tab.
  - Slash commands are typed after `❯` inside Claude Code, never in zsh.
- **Codex** (GPT) is the second builder and the independent reviewer. It works in a git worktree on branch `codex/finance`, with migrations 0200 and above, and never merges into main.
- **The lead** (this conversation) splits the work, writes the prompts, reviews the checkpoints and guards security. It never asks for passwords, TOTP secrets or keys.

## Read first, in this order
1. `CLAUDE.md`: security rules that override everything.
2. `docs/REQUIREMENTS-V1.md`: production scope, written 2 Nov from Ali's interview after his meetings with the owner and the office. This is the source of truth.
3. `docs/checkpoints/CP-PROD-PLAN.md`: the task plan R1–R10 and its checklist, once Claude Code has written it.
4. `docs/DECISIONS.md`: numbered decisions; 114–120 cover the assistant.
5. `docs/HANDOFF-CODEX.md`: architecture, history, rules and rejected ideas (version 2).
6. `docs/checkpoints/CP-ASSIST-1.md` and `CP-INTEGRATION-2.md`: the latest completed waves.

## State on 2 Nov
- The pilot is complete on `main`, commit `44b5732`, with fake data:
  - integration chain;
  - assistant v1 on the scripted provider;
  - 3 442 tests and 140 e2e passing.
- **There is no git remote.** The code exists only on Ali's Mac. A private GitHub repository is needed as a backup, after a secret scan of the history.
- **Phase change:** production build for real data on a server in Morocco.
  - Week of 2 Nov: build.
  - Week of 9 Nov: accounts and training.
  - Rest of November: semi-trial.
  - 1 Dec: go-live.
- **Plan this week:**
  - **Claude Code:** Batch A (R1 plants, R2 roles, R3 prices and approvals, R4 driver and pump PWA, R9 production readiness), then Batch B (R5 notifications, R6 cancellations, R7 documents, R8 Darija, R10 deterministic assistant).
  - **Codex:** finance module (§10 and §3.8) in parallel, then the security review on the final main on Friday.
  - **Wednesday:** internal version on the server. **Friday and Saturday:** regression, review, data import.
- **Claude Pro weekly limit** resets on Thursday at 03:00, then every Thursday at 03:00. Max is not possible before December. Ali's second Pro account is the fallback.
- **Pending from the lead:**
  - hosting choice: a VPS in Morocco, judged on stability, security and cost;
  - questions for the plants and drivers interview on Tue 3 Nov;
  - draft of the CNDP declaration.

## Hard rules decided with Ali
- **No external LLM on real data** until the CNDP authorizes it. The assistant stays deterministic until then.
- **Client and supplier portals** are switched on last, after the independent review.
- **No "black" or no-VAT sales mode, and no disguised names** in accountant or tax documents. The lead refused both. Legally exempt operations are allowed only with their legal reference.
- **Module flags:** a module is switched on only when its tests pass on the server.
- **The CNDP declaration** is filed before any real personal data is entered.

## Artifacts in Ali's first account (private unless he shares them)
- "BELGOBETON — Vision 2", the integrated mockup: https://claude.ai/artifact/Ewwqsb3fGfBewgA51fe5V4
- "BELGOBETON — Vision pilote", shared by link: https://claude.ai/artifact/JPfGeyxrQLj5mTmH8jtNuf
- Owner meeting document (Docs): XucYc8cKzoY46X2Pu8mtYa

Mockups are illustrative only, not requirements.

## Next actions, in order
1. Ali pastes the Batch A prompt into Claude Code and the finance prompt into Codex. The prompts are in the lead conversation of 2 Nov; their content follows `REQUIREMENTS-V1.md` and the plan above.
2. The lead delivers the hosting choice before Wednesday.
3. Tuesday: the plants and drivers interview. Amend REQUIREMENTS-V1 §6 and §7.
4. Review the end-of-Batch-A report, then release Batch B.
