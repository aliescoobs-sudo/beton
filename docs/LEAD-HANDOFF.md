# BELGOBETON — Lead handoff (for a new lead conversation)

Last update: 7 Nov 2026 (state at commit `f3cb07d`, review R14 included). This file is kept up to date by the lead conversation at every milestone. A new lead conversation (for example on Ali's second Claude account) starts by reading this file, then the files it points to.

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

## State on 7 Nov (commits through `f3cb07d`)
`main` is on GitHub (private remote `origin`), CI builds the image on every push. Everything is fictitious data. Migrations run through 0118. Details: `docs/checkpoints/CP-PROD-PLAN.md` (one section per batch), `docs/DECISIONS.md` (160 to 180), `docs/reviews/`.

### What was built since 2 Nov
- **Batches A to C, C+ and D (final-review fixes F01 to F12):** plants, roles, prices and approvals, driver and pump PWA, production readiness, finance merged from Codex, recipes per plant, receipt variance, day-close fuel and cash, key-rotation registry, document approvals tied to the download, PIN attempt serialised. Decisions 160 to 175.
- **T1 training instance:** `TRAINING_MODE` with a boot guard and a marker table, one account per role (password only, reserved address domain `formation.beton.invalid`), banner, imports, maps, push and LLM off, generated credentials in an ignored file, `docker-compose.training.yml` bound to 127.0.0.1, scripts under `scripts/training/`. Guides: `CP-TRAINING.md` and `CP-TRAINING-IMAC-FR.md` (simple French).
- **T2 Excel importer** for go-live (`docs/IMPORT-EXCEL.md`, decision 176): dry run, apply with step-up and a confirmation phrase, soft rollback. Synthetic files only.
- **T3 / T4 / T6:** fixes of reviews R11, R12, R13 (decisions 177 and 180).
- **T5 training made usable (decisions 178, 179, migration 0118):** the seed ends with today's work, `rearm:training` brings a fresh day; stage timing, delay alerts, plant-manager reassign and postpone, estimates per plant/zone/stage; exercise cards per role in FR and AR.

### Independent reviews (Codex, read-only, `docs/reviews/`)
| Review | Object | Outcome |
|---|---|---|
| R11 | `52c2858` | Do not expose through Funnel as configured. Public PIN endpoint, credential-file handling and training-database admission had to be fixed. Fixed in T3. |
| R12 | `b672a6b` | Conditional GO for supervised fictitious-data training with the restricted profile and seven pre-opening conditions. Fixed in T4 (decision 177). |
| R13 | `99072c0` | Conditional GO, same conditions. Four medium findings and two small items (empty-database proof, per-IP release, offline epoch, Funnel reset). Fixed in T6 (decision 180). |
| R14 | `f3cb07d` | **Training: conditional GO** (supervised, wholly fictitious data) until the on-iMac conditions are recorded. **T5: exercise only, production NO-GO. Importer: real-data NO-GO. Overall real data: NO-GO.** 14 findings, none a blocker for training. Not yet fixed. |

Regression evidence is in CP-PROD-PLAN. T5: full e2e 174 passed, 2 skipped, 0 failed. T6: one full run had 6 failures on a slow machine (all sign-in/TOTP timeouts in specs T6 did not touch; all pass alone). **A second green full run on AC power is still owed**, and R14 asks for it explicitly.

### R14 findings, grouped as the pending T7 work
- **Group A, training / iMac:** R14-06 (phone logout and sync/photo continuations share no session epoch), R14-07 (Funnel check falls back to text when JSON is unusable, startup ignores a failed check), R14-12 (stale sweep can delete another seed's staged credentials), R14-13 (birth-token documentation promises more than it proves), R14-14 (17 screenshots: five show 404 pages, one shows named drivers' delays without the banner). Plus the on-iMac rehearsal itself.
- **Group B, T5 dispatch:** R14-01 (started-state checks and dispatch writes are not one serialized decision; `loading_started` is ignored), R14-02 (performance reasons leak into plan, cancellation and audit rows outside the restricted tables), R14-05 (`trip_stage_estimate` is SECURITY DEFINER with no plant or assignment scope).
- **Group C, importer:** R14-03 (COMMIT/ROLLBACK failures swallowed, success reported early), R14-04 (1904 date system ignored; duplicate headers, unclosed CSV quote and cached formula values accepted silently), R14-08 (idempotency race, conflicting rows treated as already imported), R14-09 (report can echo a cell; row audits are value-bearing), R14-10 (soft rollback names the wrong opening tables), R14-11 (CLI TOTP bypasses the one-time-step claim).
- Still deferred from earlier: none of F01 to F12 remains; the missing audit action was added (decision 175).

### On-iMac conditions (all required before Funnel is opened; none done yet)
Full list: R14 section 6 and the numbered checklist in both training guides. In short:
1. Run exactly the image of `f3cb07d` (or its fix commit), same artifact for app and ops, on a brand-new Docker volume (birth token created by initdb, claimed once, marker last). The R13 digest does not count.
2. Loopback-only socket, no host database port, accounts volume only in the ops container (uid 10001, 0700 folder, 0600 file), FileVault on, locked host, auto-login off.
3. Real Tailscale shape: complete structured status (including Foreground and Services) before and after opening, exactly one HTTPS proxy to the loopback app, closure verified at the end of every session. A failed JSON read is a refusal.
4. Phone: forwarded-IP trust, per-driver and per-IP locking, foreign or revoked device, logout with a sync in flight, handover. Use locked dedicated phones until R14-06 is fixed.
5. T5 only with invented records, one supervisor editing dispatch at a time, never to steer real work.
6. Finance roles enrol a real authenticator; HTTPS login over mobile data.
7. Regression evidence: second green full e2e.

### Hosting plan
- **Now:** training runs on a dedicated Intel iMac (linux/amd64, Colima, GHCR image pulled by digest), app bound to 127.0.0.1, published only through Tailscale. Funnel (public) is opened for a supervised session and closed after; for a private phone test use Tailscale Serve (tailnet only), which needs Serve and HTTPS certificates enabled once in the Tailscale admin console.
- **December:** the same compose on a VPS in a Moroccan data centre (decision 134, stability, security, cost). Training starts there with a fresh seed, not a restored dump. Transfers abroad (for example a provider outside Morocco) need CNDP authorization (decision 153 and `RUNBOOK.md`).
- **Real data:** blocked by the overall NO-GO of R14, the CNDP declaration, and a re-review of the corrective commits.
- Go-live date from the 2 Nov plan (1 Dec) is at risk and is Ali's call.

### Lessons learned (do not repeat)
- **Use `http://localhost:PORT`, never `127.0.0.1`.** The origin check compares the exact origin to `APP_BASE_URL`; 127.0.0.1 gives `INVALID_ORIGIN` and the generic "Connexion impossible" message. The check stays strict; do not add a second origin. Over Tailscale the origin must be the exact HTTPS tailnet URL.
- **`OTHER_DEVICE` on the driver phone** means the account is bound to another phone. It is audited and refused with a 403 until the owner or app_admin releases the device in *Chauffeurs (téléphones)*; the next sign-in then binds the new phone. This is also the release path for a lost phone (RUNBOOK section 4). Do not clear it in the database by hand.
- **Run the full e2e on AC power under `caffeinate`, one worker, nothing else running.** On battery or a slow machine the sign-in/TOTP steps time out (the T6 run took 1.6 h instead of about 30 min and showed 6 false failures). Build first with `NEXT_DIST_DIR=.next-e2e`, restore `tsconfig.json` afterwards (`git checkout tsconfig.json`), logs in `./.logs/`.
- **To end a Claude Code session type `/exit`.** Do not paste `/clear` or other slash commands from a prompt document: they are typed after the prompt marker, one at a time, never in zsh.
- zsh is not bash (`${!name}` indirection fails); run helper scripts under `bash`. A slip once ran a migration against the dev database instead of the training one; scripts now stop unless the target database name matches.
- Shared test database: use random truck codes and far dates so specs do not collide; each e2e spec that enrols a user needs its own user.
- Nobody pastes passwords, PINs or tokens into a chat, a commit or a log. Credentials live only in the ignored `training-accounts.local.txt` or the private Docker volume.

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
1. Group A to C of R14 as T7, one commit per finding, then ask Codex to re-review the corrective commit.
2. Second green full e2e on AC power; record it in CP-PROD-PLAN.
3. On-iMac rehearsal against the conditions above; record only non-secret results.
4. Ali decides the go-live date given the real-data NO-GO; CNDP declaration and VPS provider choice.
