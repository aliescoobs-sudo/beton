# SECURITY-DEBT — register of shortcuts and deferred hardening

**Purpose.** Every shortcut taken, and every hardening deferred, gets exactly one row here the day it happens. The final independent audit reads this file first and must verify each row is closed or explicitly accepted. Existing controls (RLS, SECURITY DEFINER doors, hash-chained audit, TOTP, origin check, rate limits) are never removed or weakened to save time; a deferral means "not yet added", never "turned off".

Baseline last independently audited: tag `audited-baseline-c199b84` (R22: GO for fictitious-data staging, real data NO-GO).

Fictitious data only until every row marked "before real data" is closed.

| Date | Area | What was skipped or deferred | Why | What the final audit must verify |
|---|---|---|---|---|
| 2026-11-13 | Staging scripts (R22-01) | `make-basic.sh` exits 0 without a "rotation NOT applied" message when `.env.staging` or `dc.sh` is absent/unreadable | T10k not yet done; found by R22 | Script fails closed in that case; test proves exit non-zero and message |
| 2026-11-13 | Staging scripts (R22-02) | `dc.sh` `staging/` allow-list not fail-closed if the invoking user cannot list the directory (e.g. mode 0355) | T10k | Unlistable directory is refused; test with such a mode |
| 2026-11-13 | Tests (R22-03) | Real-Caddy test accepts "not 401" where an exact 502 is expected (transport failure 000 passes) | T10k | Assertion is exact; a 000 result fails the test |
| 2026-11-13 | Docs (R22-04) | Rule 9 "clean macOS account" alternative was not isolation; removed from the handoff. Related wording (README:13, CP-STAGING:42, guide `auths` tip, rotation-guide USER placeholder) still to qualify | T10k | Docs no longer claim unconditional rotation or account-level isolation |
| 2026-11-14 | Staging host | Mode 0755 on `/srv/kayas/staging` fixed by hand; `init-env.sh`/`make-basic.sh`/guide do not yet create or enforce it; preflight lacks `ls -la /srv/kayas/staging/` | Found during the c199b84 move | Scripts enforce 0755; runbook preflight includes the listing |
| 2026-11-12 | R20-01 | `driver_trips`: same-order foreign delivery plant not constrained (migration 0225 area) | Recorded as production gate by R20 | DB-level rule rejects a trip whose plant differs from the order's delivery plant |
| 2026-11-12 | R20-02 | Purge CHECK vs `fixed=NULL` | Production gate | CHECK covers NULL; test |
| 2026-11-12 | R20-03 | Per-worksheet padding budget in the import layer | Production gate | Budget enforced per worksheet; test |
| 2026-11-12 | R20-04 | Weak negative sweeps in tests | Production gate | Sweeps assert refusal, not just absence of success |
| 2026-11-12 | R20-05 | Deploy recovery pre-journal window | Production gate | Crash before journal write is recoverable; rehearsal evidence |
| 2026-11-12 | R20-06 | Job-library end-record loss | Production gate | End record is durable or loss is detected; test |
| 2026-11-11 | R19-11 | Uploaded images are not decoded and re-encoded | Deferred before real data | Every uploaded image is re-encoded server-side; metadata stripped |
| 2026-11-11 | Audit chain | Pre-0223 audit rows not verified by the new chain check; RUNBOOK §4c query to run on each production database | Legacy rows predate the chain fix | Query run on each production DB with clean result |
| 2026-11-07 | Repository | Branch protection unavailable (403 on private free repo); gate lives in the workflow (image job needs integration) | Plan limitation | Either protection enabled, or the workflow gate proven to block an image build when integration fails |
| 2026-11-12 | Workstation (rule 9) | Developer Mac keeps CleanMyMac X and Adobe 2026 apps that fail signature checks; Ali kept them | Fictitious data only for now | Machine clean (genuine scan tools), credentials/tokens/SSH keys rotated from a clean device, evidence recorded, before any real data |
| 2026-11-15 | Planned SMS channel | Webhook signed-secret check not yet designed or built | Channel is at inventory stage | Inbound endpoint verifies a signature or shared secret in constant time, rejects replays, is rate limited, and writes the audit row for a service actor |
| 2026-11-15 | Process | Per-task independent review suspended until the final audit | Process decision 230 | Final audit covers all code after `audited-baseline-c199b84` |
| 2026-11-15 | SMS webhook gate (SPEC-sms-channel §8) | Gate for the gateway endpoint undecided: own Basic credential, or an explicit Caddy path exemption (contradicts the "whole vhost" rule). Until built, nothing is exposed | Needs Ali's numbered decision before ingestion | If exempted: matcher is exact path + POST only, all other paths still 401 (test), HMAC + timestamp + replay + body cap + rate limit verified, secret rotation procedure proven. If Basic: two-user hash file handled by scripts and allow-list |
