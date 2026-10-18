# ADR 0001 — Authentication library

- Status: **Accepted** by Ali on 2026-10-18 — option A, Better Auth 1.7.7 pinned exactly; recovery codes encrypted with a dedicated key (key never in the database, single-use, shown once, regeneration invalidates the old set, every use audited); AC-SEC-03 tested by faking the system time
- Date: 2026-10-18
- Task: T8 (tasks/todo.md), spec: SPEC-platform-security §5, assumption 🟡 A1
- Evidence: branch `spike/auth-library`, commit `1532047`, `tests/spike-auth.int.test.ts` — 17 checks run against the real PostgreSQL 17 test database on the `belgobeton_auth` role (all green; several record a gap rather than assert a pass)

## Decision to make

Use **Better Auth 1.7.7** (MIT, released 2026-09-30, pinned exactly) with its `twoFactor` plugin and `@node-rs/argon2`, or fall back to a hand-rolled stack (argon2id + `otplib` + our own session table).

## Requirement-by-requirement results

| # | Requirement (spec) | Result | Evidence / how |
|---|---|---|---|
| 1 | argon2id password hashing | ✅ native hook | `emailAndPassword.password.hash/verify` → stored `$argon2id$v=19$m=19456,t=2,p=1` (OWASP minimum; parameters configurable) |
| 2 | No public sign-up | ✅ | `disableSignUp: true` → HTTP sign-up returns 400 |
| 3 | Owner creates users server-side | ✅ with caveat | `$context.internalAdapter.createUser/linkAccount` — **internal API**: pinned version + tests guard upgrades |
| 4 | `__Host-` cookie, `Secure; HttpOnly; SameSite=Strict` | ✅ by config | Default name is `__Secure-…`; with `useSecureCookies: false`, explicit name `__Host-bb.session_token` and `secure: true` attribute → `__Host-bb.session_token=…; Path=/; HttpOnly; Secure; SameSite=Strict`, no `Domain` |
| 5 | No user enumeration | ✅ | Unknown email and wrong password: same 401, same message `Invalid email or password`; timing 10 ms vs 13 ms (dummy hash) |
| 6 | Idle timeout 30 min | ✅ | `expiresIn: 1800, updateAge: 60` → alive at 29 min, alive again 29 min after activity, dead 31 min idle |
| 7 | Absolute lifetime 12 h | ❌ **not native** | Session still valid after 12.5 h of continuous activity → our session gate must reject (and revoke) when `createdAt + 12 h` has passed |
| 8 | Server-side logout / revoke | ✅ | sign-out deletes the row; replaying the old cookie → no session. `cookieCache` disabled so revocation is immediate |
| 9 | Rotation on login and on 2FA | ✅ | Password step with 2FA on returns `twoFactorRedirect`, no usable session; TOTP step issues a new token |
| 10 | TOTP enrolment + verification | ✅ | `/two-factor/enable` + `/two-factor/verify-totp` → `twoFactorEnabled = true` |
| 11 | TOTP secret not stored in plain text | ✅ | Stored encrypted (symmetric, keyed by `AUTH_SECRET`) |
| 12 | 2FA brute-force lockout | ✅ native | Built-in `accountLockout` (default 10 failures / 15 min) → set to 5 / 15 min |
| 13 | 10 single-use recovery codes, **stored hashed** | ⚠️ partial | Codes are single-use, but storage is plain JSON by default, or `encrypted`, or custom encrypt/decrypt. Verification compares plaintext lists, so **hashing is impossible** without replacing the endpoint. Viewing codes is server-only (HTTP → 404) |
| 14 | "Trust this device" must not bypass TOTP | ❌ → ✅ by hook | Client-sent `trustDevice: true` skipped 2FA for 30 days. A `hooks.before` on `/two-factor/verify*` rejects it (400, no trust cookie) |
| 15 | TOTP replay refused | ❌ **not native** | The same code was accepted twice in its window → our hook must remember the last accepted time-step per user |
| 16 | Per-account password lockout 5 / 15 min; 20 / 15 min per IP | ❌ **not native** | Built-in rate limiter is per IP + path, in-memory by default → our `hooks.before` on `/sign-in/email` with a `login_attempt` table (also gives the audit trail) |
| 17 | Mandatory 2FA for all accounts | ❌ by design | 2FA is opt-in per user → our gate redirects to enrolment until `twoFactorEnabled` (planned in T10 anyway) |
| 18 | Step-up: `two_factor_at` ≤ 10 min | ❌ not stored | After-hook on `verify-totp` writes `twoFactorAt` to a session additional field; step-up re-runs `verify-totp` while logged in |
| 19 | Disabled user gets no session | ✅ by hook | `databaseHooks.session.create.before` returning `false` vetoes the session |
| 20 | Audit events for auth actions | ✅ by hooks | `databaseHooks` / `hooks.after` fire (11 events observed); we call `audit.record()` on the auth pool inside `withRlsContext`. Auth tables are **not** covered by the capture trigger (the library writes without our context), so auth changes are recorded as service events |
| 21 | Runs on the `auth` DB role; app role cannot read credentials | ✅ | Pool on `belgobeton_auth`; `belgobeton_app` gets `permission denied` on `account` and `twoFactor` |
| 22 | Time from `clock` | ⚠️ | The library reads `Date` directly. Sessions are real-time anyway (correct even in simulation); expiry tests use Vitest fake timers on `Date` (works, see #6/#7) |
| 23 | No telemetry / data leaving the host | ✅ | `@better-auth/telemetry` is opt-in (off unless `telemetry.enabled` or `BETTER_AUTH_TELEMETRY`); we set `telemetry: { enabled: false }` explicitly and will test that no network call is made |
| 24 | Supply chain | ⚠️ acceptable | 25 packages added (kysely, jose, @noble/*, nanostores, better-call, bundled adapters for databases we don't use — code only, their drivers are optional peers). MIT. Active project. Pinned exactly; install scripts still blocked |

## Options

**A. Better Auth 1.7.7 + hooks (recommended).** The flows that are easy to get subtly wrong are provided and were shown to behave correctly here: cookies, CSRF/origin checks, the 2FA state machine, token rotation, server-side revocation, generic errors with dummy hashing, 2FA lockout. Our gaps (#7, #13, #14, #15, #16, #17, #18) are small and sit in hooks plus our own session gate, each with its own test. Costs: one internal API for user creation, a dependency we must follow for security releases, and a deviation on recovery-code storage (#13).

**B. Hand-rolled (argon2id + otplib + own session table).** Everything is under our control: hashed recovery codes, replay protection, absolute lifetime, no internal APIs. But we would own and have to get right session cookies, origin/CSRF checks, the two-step login state, rotation, revocation, enumeration-safe errors and lockouts. That is more security-critical code to write and review, for a 5-user pilot.

## Recommendation: **GO with option A**, with these conditions

1. Pin `better-auth@1.7.7` exactly; any upgrade re-runs the full auth test suite (it covers the internal `createUser` API, cookie name and hooks).
2. Implement the gaps as tested code in T9–T12: absolute 12 h cap (#7), per-account and per-IP login lockout in a `login_attempt` table (#16), trust-device refusal (#14), TOTP replay refusal (#15), forced enrolment (#17), `twoFactorAt` for step-up (#18), disabled-user veto (#19), audit events via hooks with the anonymous actor and keyed identifier hash for unknown emails (CP2).
3. `telemetry: { enabled: false }` explicitly, plus a test that no outbound request is made during sign-in.
4. **Recovery codes (needs your decision):** store them **encrypted with our own field-encryption key** (AES-256-GCM via T16, separate from `AUTH_SECRET`) through the custom `storeBackupCodes.encrypt/decrypt` hook, and amend the spec from "stored hashed" to "stored encrypted with a dedicated key". Codes stay single-use and are never viewable over HTTP. The alternative is to disable Better Auth's backup codes and build hashed recovery codes ourselves, which relies on more internal APIs (creating a session by hand). I recommend the encrypted option.
5. AC-SEC-03 wording: session expiry is tested with fake timers on `Date` (the library does not read our clock); sessions always use real time, also in simulation.

If you choose **no-go**, the T9–T12 task list stays the same; only the internals change to option B. That is roughly 1.5–2× the work on T9–T11.

## Consequences

- New dependencies: `better-auth@1.7.7`, `@node-rs/argon2@2.2.1` (already approved).
- Better Auth's tables (`user`, `session`, `account`, `verification`, `twoFactor`) are created by our own SQL migrations (generated once from the library's schema, then reviewed), owned by the migrator, and granted only to `belgobeton_auth`. `app_user` fields from the spec (role, locale, status) become additional fields on `user`.
- Auth-table changes are audited through service events, not the capture trigger (documented exception, like `audit_event`).
