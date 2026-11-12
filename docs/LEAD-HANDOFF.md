# KAYAS (formerly BELGOBETON) — the project brain (lead handoff)

> **NAME:** the product is **KAYAS** (owner-approved 8 Nov 2026). BELGOBETON was a working name. The Project/claude.ai name and local folders (`~/BELGOBETON`, `~/BELGOBETON-finance`) keep the old name until Ali renames them. Brand: Forêt #01592B, Citron #9ADA02, Graphite #292929, Craie #F5F5F5; fonts Helvetica Neue + Geeza Pro (licensing/substitute decision open); logo only as low-res rasters; trademark (OMPIC) open. Staged in `~/BELGOBETON/brand-incoming/` (never committed). Rename Phase 2 (DB role names `belgobeton_*`, migrations, folders, GitHub repo) is a separate reviewed step.

**Version:** 2026-11-12 12:00 (Africa/Casablanca). **Master copy:** claude.ai Project "BELGOBETON", doc `claude/LEAD-HANDOFF.md`, kept by the lead conversation. **Mirror:** `docs/LEAD-HANDOFF.md` in the repo (Claude Code commits it). If they differ, this file wins for plans/rules/decisions; `docs/DECISIONS.md`, `docs/checkpoints/*`, `docs/reviews/*`, `docs/REAL-DATA-GATES.md` win for facts about code. A new lead conversation starts by reading this file, then `CLAUDE.md`, `docs/REQUIREMENTS-V1.md`, `docs/REAL-DATA-GATES.md`, `docs/STAGING-VPS.md`, the latest `docs/reviews/CODEX-REVIEW-R*.md`.

No secrets in this file, ever (no passwords, PINs, TOTP secrets, tokens, real company data).

## 0. How this file is kept alive
- The lead updates it at EVERY milestone (push, review verdict, decision, plan change, lesson): §8 state, §9 roadmap, §12 open decisions, one line in §16. Ali may say "update the brain".
- After each update, ask Claude Code (one short prompt) to mirror it into `docs/LEAD-HANDOFF.md` and push.
- If the conversation gets long or lost: open a new conversation inside the Project, say "read claude/LEAD-HANDOFF.md and continue as the lead".

## 1. The project in one paragraph
Management application for a friend's ready-mix concrete company in Tétouan (plants Tétouan = BELGO and Chefchaouen = CHAOUN; one office in Tétouan). It replaces Odoo (removed by the owner). It tracks money and materials together: clients, suppliers (cement, sand, other components), transport, fuel, what came in/out/was cancelled, cash vs cheque vs instalments, cheques due, advances, stock. The plant's own software reports what was loaded (e.g. B20) and the app deducts components by recipe. Owner has a private interface (little time, many problems); two office employees enter transactions; plants and drivers use phones. The owner wants APIs, agents and automation of routine work. Ali (builder, OBSIL MEDIA) is the owner's contact and decides everything on the build side.

## 2. People and the working protocol
- **Ali**: Moroccan, speaks Darija (answer in Darija, technical terms in English/French; prompts for tools in English, complete, in ONE block). Decides. Never share passwords, 2FA codes, keys or tokens with any AI. Works on a MacBook (Apple silicon); an Intel 2019 iMac exists. Registers accounts, accepts T&C and enters card details himself.
- **The lead (this Project's conversation)**: plans, splits work, writes prompts, reads review reports, guards security, keeps this file. Reaches the Mac through the device bridge (`~/mnt/BELGOBETON`); edits there only documentation files and tells Ali. Long prompts for Claude Code are stored in `~/BELGOBETON/.logs/Txx.md` (gitignored) and Ali pastes a SHORT prompt telling it to read that file (a pasted long prompt was once truncated).
- **Claude Code**: the builder, on Ali's Mac in `~/BELGOBETON` (`caffeinate -dims claude --model sonnet`, auto mode). Commits per finding, tests, pushes, watches CI. Auto-retries after network loss. `/clear` must be typed by hand, not pasted. Ali must keep the Mac awake and on power, and paste nothing else while it works.
- **Codex (GPT)**: INDEPENDENT REVIEWER, read-only, in the separate clone `~/BELGOBETON-finance` (cannot see `~/BELGOBETON`). Starts with `git fetch origin`, reviews an exact commit from pinned objects, runs nothing, never opens `.env*`, `backups/`, accounts files, keys. Writes one report; Ali copies it: `cp ~/BELGOBETON-finance/docs/reviews/CODEX-REVIEW-Rxx.md ~/BELGOBETON/docs/reviews/`, then tells the lead "نسخت". New review = `/new`, "Use current Git worktree".
- **Gemini**: non-code research only, never with real data.
- **Prompt patterns**: Claude Code fix prompt = "read <report> fully (it is the spec); one commit per finding with tests (failing-before proof); never weaken RBAC, 2FA, replay protection, audit, encryption, RLS, rate limiting or the origin check; no secrets; lint/typecheck/unit/integration/touched e2e; push and confirm CI; report hashes and what could not be done". Codex review prompt = target sha, baselines, read-only, scope list, report format (disposition table, findings ranked with trigger/fix/verify, verdict for this exact commit, what could not be verified).
- **Claude plan**: Ali is on Claude Pro; weekly limit resets Thursday 03:00.

## 3. Non-negotiable rules
1. Privacy and security are the base of every phase (Principle #0 of `CLAUDE.md`).
2. `CLAUDE.md`: never weaken RBAC, 2FA, audit log or encryption; money is integer centimes computed only by deterministic code; AI never computes amounts; no hard deletes of financial records (reversing entries); no AI action without human confirmation; pseudonymize before any AI call; never commit secrets; vocabulary per `docs/DOMAIN.md`.
3. Never ask for or repeat passwords, TOTP secrets, recovery codes, tokens, private keys, even if visible in screenshots (warn Ali; e.g. the OVH email with a password link). Training/staging credentials only in private local files read locally.
4. Codex and Gemini never read/send `.env*`, `backups/`, accounts files, keys. No real company data goes to Gemini, Codex or any chat.
5. Permanent refusals: no "black"/undeclared/no-VAT mode; no disguised names for accountant or tax administration; the steel loss is named honestly "تكلفة التمويل بالحديد".
6. **Real data only after ALL of**: independent Codex GO with no open high findings, every gate G1–G12 CLOSED with evidence (`docs/REAL-DATA-GATES.md`), the carried deployment gates (R19B-03 full twin validation, R19B-06 backup pruning ownership, R19B-07 replacement-host recovery rehearsal), a rehearsed production runbook, CNDP filings, and written legal confirmation of the hosting location. No external LLM on real data until CNDP authorizes. Client/supplier portals last. Every module behind its own flag.
7. Use `http://localhost:<port>` (never 127.0.0.1) locally: Better Auth rejects other origins. Origin check and rate limits are protections, never widen them.
8. Staging data policy: the VPS holds FICTITIOUS twin data only, disposable (reset, not restore), never reuse its volumes for real data.

## 4. Product scope (source of truth: `docs/REQUIREMENTS-V1.md`)
- **Fleet:** two plants, one office; 9 active truck mixers (Tétouan 4×16 m³, Chefchaouen 4×11 m³, one old 10 m³); old trucks stopped; 3 pump trucks not tied to a plant; one driver per machine; external hired trucks (basis unknown, configurable); plant fuel tank. Transport included in the m³ price; pumping is a surcharge per m³.
- **Roles:** owner, app_admin (Ali: owner-equivalent but audited), office_sales, office_purchases, plant_manager (one plant), driver, pump_operator, accountant (export-only, HT/VAT/TTC), client_portal/supplier_portal (OFF until the end), partner, support. Money visibility is a matrix: entering, seeing inside a document, balances/aggregates, exporting are separate rights; only owner and app_admin see balances, cash, bank, P&L, financing. Office enters blind (no figures).
- **Prices/credit:** reference average per type per plant gives a PROVISIONAL price; no invoice while a line is provisional; owner confirms from the phone. Credit limit and overdue invoices hold an order for owner approval.
- **Plants/stock/purchases:** stock per plant, consumption by recipe, reorder thresholds, two-step receipt with 2 % variance, inter-plant transfers, day close with fuel variance and cash per holder.
- **Driver/pump phone PWA:** stages loading_started → loaded → departed → arrived → unloading_started → unloading_finished → back; BL photo; seven cancellation cases; offline day (18 h hard limit); device binding per driver; PIN 6–8 digits.
- **Documents:** devis, BL (no price), relevé, facture d'acompte, facture définitive (timing by the accountant; numbering continues from the company's last 2026 invoice number, still to be supplied), avoir (owner/app_admin).
- **Finance** (owner/app_admin only; schema `finance`, `FINANCE_ENABLED`); **Assistant** deterministic (no external LLM); approvals inbox; notifications; languages fr/ar/Darija (`DARIJA_ENABLED`, wording to be read by a Darija speaker).
- **Dispatch/timing (T5, decision 179):** estimates from the median of the last 10 rotations (min 5), per-tap timestamps, alerts, plant manager reassign/postpone; delay data readable only by that driver, his plant manager, owner and app_admin.
- **History import (T11/T11b):** Excel history imported through a reviewed layer (staging, quarantine, twin-content validation, typed phrase + fresh TOTP, soft rollback, purge-staging 0228). Disabled on the staging VPS (`STAGING_PROFILE`).
- **Planned next (T12, not started):** hauler kind, material haul log, cost per tonne, and further items Ali agrees with the owner.
- **CNDP (7 Nov research, Gemini cross-checked; article numbers/fines unverified, needs a Moroccan lawyer or CNDP):** three filings: client management = DECLARATION (deliberation 32-2015), supplier management = AUTHORIZATION (98-AU-2015), HR/drivers/work organisation incl. per-driver timestamps = AUTHORIZATION (298-AU-2014; about 2 months). Transfer abroad is notified/authorized separately. Subcontracting contracts (developer, host) with security clauses required. Drivers must be informed and have access/rectification rights. The owner reports an ORAL assurance that proof-of-deposit receipts stand in for the authorization: unverified, his risk; ask for it in writing.
- **Future scope (Ali adds, dated):** APIs and agents, automation, portals, WhatsApp/SMS, external LLM after CNDP, other services agreed with the owner.

## 5. Architecture and conventions
- Next.js 16, TypeScript, PostgreSQL 17, Docker Compose, Caddy auto-HTTPS, RLS FORCE + SECURITY DEFINER doors (actor-first, whole-tuple rule, definer catalogue test), hash-chained audit, Better Auth (TOTP, step-up), pg-boss, Vitest, Playwright, locales fr/ar/ary. Migrations up to 0228 (finance 0200–0207). Decisions numbered up to 226.
- Delivery: image built by GitHub Actions (linux/amd64) into private GHCR, pulled BY DIGEST; the image job needs the integration workflow (branch protection is unavailable on the private free repo, so the gate lives in the workflow). The VPS never builds.
- Staging package (T10g): `docker-compose.staging.yml`, `Caddyfile.staging` (Basic Auth on the whole vhost, hash in a mounted private file), `scripts/staging/*` (approve-release, init-env, make-basic, up, reset, rehearse), `release/APPROVED` (commit, digest, platform, run id) binding every privileged wrapper, `deploy.sh` lock/journal/verified rollback, hidden-prompt TTY, `verify-host.sh` fail-closed, `STAGING_PROFILE` (history import off), container hardening. Runbook: `docs/STAGING-VPS.md`; evidence `docs/checkpoints/CP-STAGING.md`.
- Training mode (`TRAINING_MODE`, twin guard, birth token, reserved accounts), LAN door (training only, never on the VPS).

## 6. Build history (orientation; details in checkpoints)
Pilot (fake data) → production phase 2 Nov (Batches A–D) → T1–T7 (training instance, importer, dispatch) → KAYAS rebrand 8 Nov → T8 (R16) → T9 → T10a–T10d (R17/R18) → T10e (R18 close-out) → T11/T11b (history import layer, CI integration, LAN door) → **T10f (R19 close-out, migrations 0224–0228, decisions 219–222)** → **T10g (R19B staging package, decisions 223–226)**. Latest: unit 2754, integration 2800 (170 files), full e2e 214 tests in 37 min.

## 7. Independent reviews (Codex)
| Review | Commit | Verdict |
|---|---|---|
| R14 | f3cb07d | training conditional GO; importer NO-GO; real data NO-GO |
| R15b | f9a4135 | conditional GO supervised local training; importer NO-GO; real data NO-GO (13 new findings) |
| R16 | 42dc00c | conditional GO local exercise; NO-GO real; PDF legal-identity regression |
| R17 | 96befee | conditional GO local exercise; NO-GO real (3 high, 7 medium, 1 low) |
| R18 | 47ac7dc | fictitious-data STAGING NO-GO (R18-01–07, 10, 11); real NO-GO → T10e |
| R19 | 1a6d990 | STAGING NO-GO (R19-01–06, 12); real NO-GO → T10f |
| R19B-DEPLOY | 4243a70 | VPS staging NO-GO (R19B-01–04, 06–07) → T10g |
| **R20** | **4191ccc** | **pending**: narrow verification of R19 + R19B fixes, GO/NO-GO for fictitious-data staging |

## 8. Current state (12 Nov 2026, 12:00)
- **Code:** `main` = `4191ccccce2725ebcbed7dc43979ee7612b2f0b3`, CI fully green (lint/types/unit, integration, image build/publish). Tree clean except untracked `brand-incoming/`. T10f done (R19-01…12 + group 3 sweeps + purge-staging). T10g done (R19B containment for staging). Last fixes: flaky substring tests on random sealed values, `deploy-run --recover` clears a stale git index lock.
- **Not done as written (accepted, recorded):** branch protection (403 on private free repo; workflow gate instead); image decode/re-encode (R19-11: metadata stripped, wide-gamut profile dropped); pre-0223 audit-row query to run on each production database (RUNBOOK §4c); real two-image deploy/rollback rehearsal (stub Docker only); Let's Encrypt, real DNS, UFW, phones, reboot, CI-built digest not exercised yet.
- **Codex R20** on `4191ccc`: prompt issued 12 Nov ~11:55 (Ali pastes in `~/BELGOBETON-finance`). Waiting. Then: copy report, lead reads it, fixes round if needed, new approved digest.
- **Staging VPS (OVH VPS-1, Canada Beauharnois):** 2 vCore, 4 GB RAM + 2 GB swapfile, 38 GB disk, Ubuntu 24.04.5, kernel 6.8.0-149. Paid 62.16 DH TTC/month, order 263617468, NO commitment, MANUAL renewal: renew before 11 Dec 2026 (reminder 5 Dec). IP 149.56.132.58, host `kayas.aliobsil.com` (A record in OrangeHost cPanel Zone Editor, TTL 300, verified; NO AAAA). SSH key-only with key `~/.ssh/kayas_vps` (passphrase in macOS Keychain); user `ubuntu` (sudo); drop-in `/etc/ssh/sshd_config.d/00-kayas.conf` (PermitRootLogin no, PasswordAuthentication no, MaxAuthTries 3, LoginGraceTime 30; `00-` so it wins). UFW deny-in, 22/80/443 (v4+v6) — SSH not yet restricted to an admin IP. fail2ban sshd jail (4/10 min, 1 h), unattended-upgrades (no auto reboot), time sync OK, UTC, Docker 29.9.3 + Compose v5.7.1 (official repo), `/etc/docker/daemon.json` json-file 10m×3 + live-restore, `ubuntu` not in docker group (sudo docker). Only port 22 listens. Docker-published ports bypass UFW (the stack publishes only 80/443; verify with `verify-host.sh --staging`). Nothing of KAYAS deployed. A dedicated `deploy` user is still to be created by the runbook. Daily provider backup (standard) + snapshot option exist; staging policy is reset, not restore.
- **Ali's manual to-dos:** delete the OVH email containing the password-reset link (the password is irrelevant now, but do not open or share it); reminder 5 Dec for OVH renewal; later, owner/lawyer items in §12.
- **Training instance on the Mac:** `http://localhost:3300` (fictitious). Tailscale dropped (7 Nov).

## 9. Roadmap (in order)
1. **R20** (Codex, narrow verification) → lead reads → fix round (Claude Code) if blockers.
2. **Deploy staging** on the OVH VPS strictly by `docs/STAGING-VPS.md` (Ali does registration/token/card steps; lead guides step by step with screenshots): pin the approved release (commit/digest/platform/run id from a green CI run), `deploy` user + second-session test, read-only GHCR token (classic `read:packages`, 30-day expiry), `approve-release.sh`, `init-env.sh`, `make-basic.sh`, `up.sh`, owner/admin TOTP enrolment over HTTPS before sharing the address, external checks (401 without/with wrong Basic, 200 + app login with valid Basic, alternate host/IP/port, certificate, external all-port scan, `verify-host.sh --staging`), reboot rehearsal. Consider restricting SSH to an admin IP.
3. **Phone tests** (G6) on real phones against staging, supervised pilot with fictitious data; owner walk-through.
4. **T12** feature work (hauler kind, material haul log, cost per tonne) on the reviewed base; every security-relevant change is reviewed before staging digests move.
5. **Production gates:** G1–G12 evidence (`docs/REAL-DATA-GATES.md`), R19B-03 full twin validation, R19B-06, R19B-07 (replacement-host recovery rehearsal), backup design (age-encrypted dumps pulled to an office machine in Morocco, keys escrowed), production runbook rehearsal, final independent GO.
6. **Legal/hosting:** lawyer's written confirmation on hosting location (Switzerland/EU/Canada vs Morocco) and CNDP filings before ANY real data; short subcontracting contract. Production host is a SEPARATE decision (Infomaniak Switzerland was the earlier choice; OVH/others reconsidered).
7. **Excel real data:** office headers/mapping, import only after the gates.
8. Timeline: the 1 Dec go-live target is not realistic if done lawfully; the semi-trial stays on fictitious data. Owner's decision with his legal adviser.

## 10. Where everything is
- Repo `~/BELGOBETON` (private GitHub repo). Key docs: `CLAUDE.md`; `docs/REQUIREMENTS-V1.md`; `docs/DECISIONS.md`; `docs/REAL-DATA-GATES.md`; `docs/STAGING-VPS.md`; `docs/RUNBOOK.md` (production); `docs/checkpoints/` (CP-PROD-PLAN, CP-TRAINING, CP-STAGING…); `docs/reviews/CODEX-REVIEW-*.md` and `*-RESPONSE.md`; `docs/IMPORT-EXCEL.md`; `docs/training/`; `docs/DOMAIN.md`, `BRIEF.md`, `HANDOFF-CODEX.md`.
- Private (never in git/chat): `~/BELGOBETON-data` (real files, chmod 700), `~/BELGOBETON/training-accounts.local.txt`, `~/.ssh/kayas_vps`, GHCR token, Basic Auth credentials, key escrow.
- `~/BELGOBETON/.logs/` (gitignored): e2e logs, long task specs `T10f-rest.md`, `T10g.md`.

## 11. Lessons and gotchas
- `pnpm` missing in a new terminal: `corepack pnpm …`. Never `claude --model sonnet.`.
- e2e: one full pass on AC power under `caffeinate -dimsu` (~35–45 min); Mac sleep on battery caused fake timeouts.
- Claude Code resumes after a network loss by itself (10 retries); say "continue" if not. Ignore "Update installed".
- SSH: "Enter passphrase for key" is the LOCAL key passphrase, not the server password (use `ssh-add --apple-use-keychain`). sshd takes the FIRST value it finds across drop-ins in lexical order (`00-kayas.conf` wins over cloud-init's `50-`). Always test a SECOND session before closing the first. Ubuntu 24.04 starts sshd on first connection (socket), so `/run/sshd` may be missing for `sshd -T` (create it).
- Docker bypasses UFW for published ports; publish only 80/443. `sudo docker` (docker group = root-equivalent).
- bcrypt hashes contain `$`: never put them in Compose env; mount a file.
- Tests that assert a substring of a random sealed value are flaky; assert format instead.
- Rate limiting is a protection; never retry blindly (5 wrong PINs lock a driver).
- Screenshots may expose secrets or links (OVH reset link): warn, do not open, do not repeat.
- The lead must not guess: verify in the repo through the bridge; when a plan changes, update this file.

## 12. Open decisions (Ali / owner / accountant / lawyer)
- **Production hosting location** and the lawyer's written confirmation (CNDP, transfer abroad), plus the contract with the host/developer.
- Go-live date vs real-data gates; owner's treatment of CNDP timing.
- Named-driver delay statistics: purpose, retention, correction process, notice to workers.
- Owner: external truck pricing basis, cancellation fee policy, reference price per plant, accountant read scope.
- Accountant: final invoice timing, legal exemptions with references, export format, last 2026 invoice number.
- Dispatch assumptions of T5 (5-min tolerance, 10-rotation median, default waiting 0): confirm in training.
- Real Excel headers, sheet names, available history.
- Branch protection: free private repo returns 403; accept the workflow gate, upgrade the plan, or move the repo.
- Image re-encoding (R19-11) and pre-0223 audit rows: before real data.
- Who operates the VPS day to day; the backup holder in Morocco; OVH renewal ownership (manual until enabled).
- Brand: font licensing, logo vector master, OMPIC.

## 13. Idea backlog (add dated entries)
- 12 Nov 2026: T12 items (hauler kind, material haul log, cost per tonne).

## 16. Change log
- 2026-11-12 12:00 — Full rewrite of the brain (it was stale since 8 Nov). T10f finished (HEAD 64fabf4, CI green); T10g finished (e4b0cef) then flaky/lock fixes (4191ccc, CI green). Codex R20 prompt issued on 4191ccc. Staging VPS bought and hardened (OVH VPS-1 Canada, Docker installed, DNS verified) but nothing deployed. Superseded: Infomaniak VPS Lite plan for staging; T7 prompt and R15 skeleton appendices removed.
- 2026-11-11 — OVH VPS-1 ordered (62.16 DH/month, manual renewal), SSH key-only access, patched, UFW/fail2ban/unattended-upgrades/swap/Docker; R19B deployment review received (NO-GO) → T10g.
- 2026-11-11 — T10e, T11/T11b, T10f group 1 pushed; R18 and R19 received.
- 2026-11-09/10 — R16, R17 received; T8/T9/T10a–d.
- 2026-11-08 — Rebrand to KAYAS (Phase 1); R15b received.
- 2026-11-07 — R14; Tailscale dropped; CNDP research; T7.
- 2026-11-02/06 — Production phase, Batches A–D, T1–T6, R11–R13.
