# CP-STAGING — local rehearsal evidence for the staging VPS stack (T10g)

12 Nov 2026, Mac (Colima, linux/arm64), commits `66ab64b` (A), `cb59c28` (B), `36fe7ff` (D), `111e904` (C). No secret in this file: the Basic credentials of the rehearsal are canaries made at run time and deleted. **This proves the configuration, not a deployment**: the image is built from the checkout and run by content id (`sha256:c20e9071…`, linux/arm64), Caddy uses its internal CA on loopback ports 18080/18443, nothing remote was contacted.

## Commands and results

| Command | Result |
| --- | --- |
| `./scripts/staging/rehearse.sh` (builds the image, creates `.env.staging*` with the real `init-env.sh`, the hash with the real `make-basic.sh` in batch mode, runs the real `up.sh`, then the checks, then removes everything) | rc 0 — `rehearsal checks: all passed` (144 `ok`, 0 `FAIL`), Playwright `5 passed`. Run three times during development (the first runs found: the SWC native addon needs an `exec` tmpfs on a read-only root; the TLS snippet fails with an empty `STAGING_TLS`; Caddy-generated 401s lacked the headers). |
| `up.sh` order | `db` only → `db-bootstrap` ("Bootstrapped roles and databases") → `db-migrate` ("Migrations applied") → `seed-training` ("Training data seeded: 11 accounts") → app healthy + 8 s boot-probe pause → proxy healthy. Every step through the strict wrapper ("validate-compose: staging configuration accepted") with an evidence line. |
| Containers (all with `read_only`, `cap_drop ALL`, `no-new-privileges`, memory/pids limits, `json-file` 10m×3) | db, app, proxy: running, healthy; app uid 10001, root filesystem not writable. |
| `corepack pnpm exec vitest run --project unit` | green (2860+ tests; new: `staging-config` 44, `release-binding` 44, `operator-path` 29, `staging-profile` 10). |
| `corepack pnpm exec vitest run --project integration` | 170 files, 2800 tests passed (includes `twin-decide-scope`, 5). One earlier run had a single pre-existing flaky assertion (`assistant-drafts`, a random ciphertext matching `MAD`) that passed on rerun. |
| lint / typecheck / prettier | 0 errors (29 pre-existing warnings), 0 type errors, prettier clean. |

## What the 144 checks cover (`scripts/staging/rehearsal-checks.sh`)

- No credentials and wrong credentials → 401 with `WWW-Authenticate: Basic` on 20 paths (pages, RSC/static, auth, field, APIs, health, `//`, `%2e%2e`), on POST/PUT/PATCH/DELETE/OPTIONS of auth/field/push endpoints, on HEAD, and with a 2 MB body.
- **Nothing reached the app:** the phone sign-in writes one `login_attempt` row per request that reaches it; the count was unchanged after the whole refused burst, and a valid-Basic control request incremented it by exactly one.
- 401 carries HSTS, nosniff, frame DENY, referrer no-referrer, no `Server`.
- HTTP → HTTPS redirect (scheme/host; Caddy omits a non-443 port), unknown Host → 404, bare address and other names not served over HTTPS.
- Valid Basic → the app's login page (training banner), `/api/health/ready` still hidden, a protected page still redirects (app session needed), `api/field/session` answered by the app (no Basic challenge), a static asset 401/200, `sw.js` and the manifest 200.
- Published ports: only the proxy, exactly two, loopback; db and app none.
- Forged `X-Forwarded-For/Host/Proto/X-Real-Ip` and `Authorization`: with the real `Caddyfile.staging` in front of an echo server the upstream sees the connection peer, `https`, the real host, and no `Authorization`; 3 forged-XFF sign-ins count against one client address.
- Hardening is real (inspect shows the flags and limits), logs hold neither the canary password nor an `Authorization:` header.
- Browser (Playwright, Chromium): with credentials the login page, scripts and field page load, no request is refused afterwards, a service worker installs and activates; without or with wrong credentials the page is 401 and the worker is refused.

## Not done / needs the owner

Certificate issuance by Let's Encrypt, the real DNS and UFW, the external IPv4 all-port scan, a phone's Basic prompt, the reboot rehearsal, the CI-built digest of the final commit, and everything in `docs/STAGING-VPS.md` §3–§16. No VPS was touched.

## After R20 (T10h, 12 Nov 2026)

Codex R20 verdict: **GO for a fictitious-data staging instance; real data NO-GO.** Changes since the rehearsal above (details `docs/reviews/R20-RESPONSE.md`, decision 227): the staging guide was corrected (R20-07); `.dockerignore` keeps `e2e-staging`, `playwright.staging.config.ts` and `*.spec.ts` out of the image (R20-08, `scripts/dockerignore.test.ts`); `staging/dc.sh` and `validate-compose.py` validate the effective domain, origin and TLS mode before any container call (R20-09, `scripts/staging-config.test.ts`). `scripts/staging/rehearse.sh` was **re-run on the final code**: rc 0, all checks passed (including the 5 Playwright checks) on the rebuilt local image (linux/arm64, content id `sha256:e1b9cf6a…`), through the new `dc.sh` override refusals and the new effective proxy-input validation. The image content check of the guide exits 0 on that rebuilt image; on the image built before the fix it names `/app/e2e-staging` and exits 1, and it passes an older clean image. `staging-config` now has 46 tests. Still not done: certificate issuance, DNS, UFW, the external scans (IPv4 and every global IPv6 address), a phone's Basic prompt, the reboot rehearsal, the CI-built digest of the final commit.

## After the first real deployment (T10i, 12 Nov 2026)

The first VPS start showed that the proxy could not read the 0600 Basic Auth hash (decision 228, `docs/reviews/R21-NOTES.md`): the hardened proxy's root has no `DAC_OVERRIDE`, and the macOS rehearsal masked file ownership. Fixed: the hash is mode 0644 (hash only), the compose mounts the `staging/` directory read-only (a rename no longer leaves the proxy on an old inode), `make-basic.sh` recreates a running proxy, `dc.sh` checks owner/mode/type, `up.sh` diagnoses and verifies the proxy. New evidence: `tests/staging-proxy-readability.int.test.ts` (real caddy image, the proxy's flags, a foreign uid; fails on the old script, passes now), `scripts/staging-up-proxy.test.ts`, extended `scripts/staging-config.test.ts`. The local rehearsal does not prove file ownership on Linux; this Docker-volume test does. The VPS is a fictitious-data staging only; it is not declared production-ready.

## After R21 (T10j, 13 Nov 2026)

R21 verdict: **GO for moving the fictitious-data staging to the T10i image; real data NO-GO.** Fixed in T10j (decision 229, `docs/reviews/R21-RESPONSE.md`): a rotation of the Basic credential is reported applied only when the proxy was recreated and confirmed healthy (non-zero "rotation NOT applied" otherwise; the real caddy image shows the old password keeps working until the recreation); `dc.sh up` runs the hash/directory gate for every invocation that can start the proxy; the proxy-visible `staging/` directory is allow-listed; README, tests' wording and the registry-credential check corrected; two production gates added (proxy secret delivery, workstation hygiene). No application code changed. Still not done: any check on the real host (rotation on the VPS, TLS, reboot, external scans) and every gate G1–G12.
