# Spec: `platform-security`

Status: DRAFT · Depends on: — · Shared conventions: [CAPABILITY-MAP.md](CAPABILITY-MAP.md)

## 1. Objective
The foundation that implements principle #0: only known people get in (password + 2FA), each person sees and does only what their role allows (enforced in the app **and** in PostgreSQL), every change is recorded permanently with who/when/what, data is encrypted in transit and at rest, and backups can actually be restored. Every other module builds on this one.

## 2. Scope
In: users, login, TOTP 2FA, sessions, roles + permission matrix, RLS context, audit log (capture, hash chain, viewer, verify), field encryption, secrets handling, security headers, rate limiting, parameters store, encrypted backups + restore test, pre-real-data security checklist.
Out: SSO, SMS, password-less, multi-tenant, SIEM integration.

## 3. Data model

| Table | Key columns | Notes |
|---|---|---|
| `app_user` | id, display_name, email (unique), role (`owner`/`partner`/`office`/`plant`), locale (`fr`/`ar`), status (`active`/`disabled`), created_at | No CIN (🟡 D57). Disabled, never deleted |
| `credential` | user_id, password_hash (argon2id), totp_secret_enc, totp_enabled_at, recovery_codes_hash[] | Owned by auth lib (🟡 A1); secrets encrypted |
| `session` | id (random 256-bit), user_id, created_at, last_seen_at, two_factor_at, ip_hash, user_agent | httpOnly cookie holds id only |
| `login_attempt` | email_hash, at, success, ip_hash | rate limiting + lockout |
| `audit_event` | id (bigserial), at (real), sim_at, actor_user_id, actor_kind (`user`/`system`/`ai_confirmed`), request_id, table_name, row_id, action (`insert`/`update`/`reverse`/`archive`/`login`/`permission_denied`/…), before jsonb, after jsonb, reason, prev_hash, hash | Append-only |
| `parameter` | key, value jsonb, updated_by, updated_at | Typed registry in code; every change audited |
| `security_checklist_item` | key, status, evidence, checked_by, checked_at | D37 gate |

Encrypted columns (AES-256-GCM in app, key from `FIELD_ENCRYPTION_KEY`, key id stored with ciphertext for rotation): TOTP secrets, phone numbers, emails of contacts, Telegram chat ids, free-text addresses. Searchable lookups use a keyed HMAC column, not the plaintext.

## 4. Roles and permissions (RBAC)

Source: 🟡 D33, ✅ A9, 🟡 A10, OQ10. `R` = read, `W` = create/reverse, `—` = no access (rows invisible via RLS, routes return 404).

| Resource | owner | partner | office | plant |
|---|---|---|---|---|
| Users, roles, 2FA reset | W | — | — | — |
| Parameters (thresholds, VAT, tolerances) | W | R | — | — |
| Clients / suppliers master | W | W | W | — |
| Concrete types, recettes | W | W | R (no cost) | R (quantities only) |
| Purchase prices, component costs | W | W | R on purchases they enter | — |
| Selling prices (list + per-client overrides, ✅ A27) | W | W | R | — |
| Trucks, zones | W | W | R | W (status/breakdown) |
| Orders + payment plan | W | W | W | R (type, m³, date, site, zone — no price, no client finance) |
| Payment instruments, money accounts entries | W | W | W | — |
| Invoices (internal) | W | W | W | — |
| Purchases, supplier payments | W | W | W | R (receipt lines: component, qty) |
| Deliveries / BL | W | W | R + record signed-BL return (✅ A11) | W (create loads + record signed-BL return) |
| Stock movements, physical count, plant import | W | W | — | W |
| Margins per delivery | R | R | — | — |
| Cash position, forecast, risk alerts, options | R + reclassify | R + reclassify | — | — |
| Échéance task list (due items) | R | R | R (own + unassigned) | — |
| Stock & reconciliation alerts | R | R | — | R |
| Client/supplier colour | R | R | R | — |
| Audit log viewer | R (all) | R (all) | R (own actions) | R (own actions) |
| AI Q&A / commands | yes | yes (🟡 A22) | assisted entry only | — (MVP) |
| Simulation controls | W | — | — | — |
| Backups / checklist | W | — | — | — |

Enforcement is layered:
1. **Route/action guard** — every server action and route declares a required permission; default deny.
2. **Service guard** — services check permission again (no trusting the UI).
3. **PostgreSQL RLS** — every business table has `ENABLE` + `FORCE ROW LEVEL SECURITY`; policies read `current_setting('app.role')` / `app.user_id`, set with `set_config(..., true)` (transaction-local) at the start of each service transaction. The app DB role has no `BYPASSRLS`, no table ownership, no `DELETE` on financial tables, no `UPDATE`/`DELETE` on `audit_event`.
4. **Column restriction** — fields hidden from a role (prices for plant, margins for office) are served through role-specific views/queries; RLS tests assert they are absent from responses.

Migrations run with a separate `migrator` role; jobs run as a `system` actor with an explicit, minimal permission set.

## 5. Authentication and sessions
- Passwords: argon2id, min 12 chars, checked against a local common-password list; no composition rules.
- 2FA mandatory for all accounts (🟡 D35): TOTP (RFC 6238, 30 s, ±1 step) enrolment forced at first login; 10 single-use recovery codes, shown once, stored hashed (🟡 A7). Only the owner can reset another user's 2FA; the reset is audited and forces re-enrolment.
- Sessions (🟡 A8): idle 30 min, absolute 12 h, cookie `__Host-` prefix, `Secure; HttpOnly; SameSite=Strict`, rotated on login and on 2FA. Logout invalidates server-side.
- Step-up: actions marked *sensitive* (confirm AI command, reclassify alert, reverse a financial entry, change parameters, move sim clock, user admin) require `two_factor_at` ≤ 10 min, else re-prompt TOTP.
- Rate limits: 5 failed logins / 15 min per account → 15-min lock; 20 / 15 min per IP; generic error messages (no user enumeration).

## 6. Audit log
- Captured by a PostgreSQL trigger on every business table (`AFTER INSERT OR UPDATE`) writing `before`/`after` jsonb + actor from `app.*` settings; a missing `app.user_id` aborts the transaction (no anonymous writes). Encrypted columns are logged as ciphertext.
- Service-level events (login, logout, failed login, permission denied, export, AI proposal/confirmation, Telegram link) are written by `auditService.record()`.
- Hash chain: `hash = sha256(prev_hash || canonical_json(event_without_hash))`, computed in the trigger under an advisory lock to keep order. `pnpm audit:verify` recomputes the whole chain.
- Immutability: `REVOKE UPDATE, DELETE, TRUNCATE` from all app roles + a `BEFORE UPDATE OR DELETE` trigger that raises. Retention: kept for the life of the system (pilot); archived, never deleted.
- Viewer: filter by date, person, entity, action; each business record page has a "history" tab (R21 traceability).

## 7. Encryption, secrets, transport, backups
- Transit: HTTPS only (HSTS 1 year in deployed envs); local dev over http://localhost allowed. DB connection with TLS in any deployed env.
- At rest: deployed DB on an encrypted volume (provider-managed) + field-level encryption above (🟡 D36).
- Secrets only from environment variables, validated at boot with Zod (`src/lib/env.ts`); app refuses to start if any is missing. `.env.example` lists names, never values.
- Headers: strict CSP (nonce-based scripts, `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `Permissions-Policy` minimal. Server Actions keep Next's origin check; no permissive CORS.
- Logs: structured JSON, no PII, no amounts, no tokens; request id correlates with audit.
- Backups (🟡 D36): daily `pg_dump` piped to `age` encryption with a recipient public key; private key stored off-host. `pnpm backup:restore-test` restores into a scratch DB, runs migrations-status check, row counts and `audit:verify`; scheduled weekly in deployed envs, result stored as a checklist item.

## 8. Security checklist (gate before any real data, 🟡 D37)
Stored in `security_checklist_item`; the app shows a banner "Données fictives uniquement" until all pass and the owner signs off. Items: all CI security tests green; restore test < 7 days old; all users have 2FA; no default/seed accounts active; dependency audit clean (high+); CSP active; CNDP declaration filed (🟡 D39); Moroccan hosting in place (🟡 D52); AI ZDR + provider contract (🟡 D51); penetration-style review of RBAC by a second person.

## 9. Acceptance criteria
- **AC-SEC-01** A user without TOTP enrolled cannot reach any page other than enrolment after password login.
- **AC-SEC-02** Login with correct password but wrong TOTP fails; 5 failures lock the account 15 min; error text is identical for unknown email and wrong password.
- **AC-SEC-03** Session expires after 30 min idle and 12 h absolute (tested with `clock` real-mode fake timers).
- **AC-SEC-04** For each table × role in §4: allowed reads return rows, denied reads return 0 rows via direct SQL as the app role with that `app.role` set (integration test matrix generated from the permission table).
- **AC-SEC-05** A plant-role response for an order contains no price, total, payment plan or client contact field; an office-role response for a delivery contains no margin or cost field.
- **AC-SEC-06** Any `INSERT`/`UPDATE` on a business table without `app.user_id` set fails.
- **AC-SEC-07** `UPDATE`, `DELETE`, `TRUNCATE` on `audit_event` fail for the app role and for the migrator role; `DELETE` on any financial table fails for the app role.
- **AC-SEC-08** Every insert/update on every business table produces exactly one `audit_event` with actor, real time, sim time (when sim enabled), before/after; `pnpm audit:verify` passes, and fails if any stored event is altered with superuser in a test.
- **AC-SEC-09** Sensitive actions without a TOTP check in the last 10 min prompt for TOTP and are not executed until it succeeds.
- **AC-SEC-10** Encrypted columns are not readable as plaintext in a raw `SELECT`; decrypt round-trip works; key rotation re-encrypts with a new key id.
- **AC-SEC-11** App fails to boot when a required env var is missing; no secret appears in logs (log-scan test).
- **AC-SEC-12** `pnpm backup` produces an `age`-encrypted file; `pnpm backup:restore-test` restores it and `audit:verify` passes on the restore.
- **AC-SEC-13** Responses carry the CSP and security headers listed in §7.
- **AC-SEC-14** Disabling a user ends their sessions immediately; their history remains intact.

## 10. Assumptions relied on
🟡 D33 (RBAC shape), 🟡 D34 (immutable audit, no hard deletes), 🟡 D35 (2FA all), 🟡 D36 (encryption + backups), 🟡 D37 (fake-data pilot + checklist), 🟡 D39 (CNDP), 🟡 D52 (Morocco hosting), 🟡 D57 (no CIN), 🟡 A1, A7, A8, A10, ✅ A9, OQ10.
