# Design note (PROPOSAL, not implemented): optional local HTTPS for the training instance

Status: **proposal for the owner's decision.** Nothing in this note is built. No cookie flag, header, origin rule or compose port changes until the owner approves. Written 9 Nov 2026 (T8-E).

## Problem
The session cookie is `__Host-…`, `Secure`, `HttpOnly`, `SameSite=Strict` (`platform-security/auth/options.ts`). Browsers treat `http://localhost` and `http://127.0.0.1` as a secure context, so Chrome and Firefox keep a `Secure` cookie there. **Safari (macOS and iOS) does not reliably store a `Secure` cookie from plain `http://`**, so on Safari or on an iPhone reaching the Mac the training login can fail silently. The policy (R15A-06) is local only, one Mac, loopback, no tunnel; the phone screen is exercised in a browser on that Mac. A real iPhone on the Wi-Fi would need HTTPS, hence this note.

## Options
| | A. Do nothing | B. Local HTTPS on loopback only | C. Local HTTPS on the LAN for phones |
|---|---|---|---|
| Who can connect | this Mac | this Mac | any device on the Wi-Fi |
| Safari on the Mac | use Chrome/Firefox | works | works |
| Real iPhone | not possible | not possible (loopback) | works, after trusting a local CA on the phone |
| Policy R15A-06 (local only) | kept | kept | **broken: needs a new owner decision and a new review** |

Recommendation: **B if Safari on the Mac matters, otherwise A.** C is out of the current policy (a listening LAN port on a credential-bearing Mac) and is not designed here.

## Option B in practice
- The `proxy` service already exists in the compose file under `--profile public` (Caddy). A separate profile `local-https` would run Caddy with `tls internal` for `localhost` only, publishing **`127.0.0.1:8443`** and nothing else, reverse-proxying to `app:3000` on the internal network. The app keeps its own `127.0.0.1:3000`.
- `APP_BASE_URL` becomes `https://localhost:8443` (`set-url.sh` would accept this one loopback https name). The origin check keeps comparing against this single exact origin.
- The certificate comes from Caddy's internal CA. Trusting it is a one-time, per-Mac step in Keychain (`caddy trust`), done by the operator. The CA key stays in a Docker volume of the proxy only.
- The cookie flags **do not change**: `Secure` stays on, `__Host-` prefix stays, `SameSite=Strict` stays. The field-login cookie already computes `secure` from `APP_BASE_URL.startsWith('https://')`.
- Helpers get the same loopback-only guard as today; `training-up.sh` prints the https address when the profile is active.

## Security implications
- **No flag is relaxed.** The goal is the opposite of "allow insecure cookies": make the transport match the cookie. Never set `secure: false` for Safari's sake.
- **Local CA trust is a standing risk on that Mac.** Whoever obtains the CA private key can mint certificates the Mac trusts for any site. Mitigations: key only in the proxy volume (mode 0600, not in the checkout, not in a backup), name constraints are not supported by Caddy's internal CA, so **remove the CA from Keychain and delete the volume when the exercise ends** (`caddy untrust`, `down -v`). This is why B stays opt-in and off by default.
- **Attack surface.** One more listener, on loopback only (`127.0.0.1:8443`, never `0.0.0.0`). A test asserts this the same way the compose test already asserts the app port. No new route, no new header logic; Caddy adds HSTS **off** for `localhost` (HSTS on `localhost` would poison other local dev servers).
- **CSP, origin check, rate limiting, lockout, 2FA, RLS, audit** are untouched. The rate limiter keys on a hashed client address: behind the proxy every request comes from the proxy's address, so the proxy must pass the real address (`X-Forwarded-For`) and the app must trust it only from that one internal address. This is the part that needs the most care in the implementation and its own test, otherwise all trainees would share one lockout counter.
- **Operator duties stay** (no publisher on the Mac, FileVault, separate browser profiles). Local HTTPS is not evidence of any of them.
- **Not a step toward production.** Production uses a public certificate (Let's Encrypt via Caddy, `docker-compose.prod.yml`); nothing here changes that.

## Work and tests if approved
1. Compose profile `local-https` (Caddy, loopback bind, internal CA volume, no HSTS), plus a compose test (bind address, no other port, profile off by default).
2. `set-url.sh`: accept `https://localhost:8443` only (and keep the http loopback names).
3. Trusted-proxy handling for the client address, with an integration test that two different forwarded addresses get separate login counters and that a request not from the proxy cannot spoof one.
4. Guide: the Keychain trust and untrust steps, and the "remove it afterwards" rule.
5. e2e: sign-in works over `https://localhost:8443` in WebKit (Playwright `webkit`), cookie keeps `Secure` and `__Host-`.

## Decision needed from the owner
Approve B (yes/no)? If C (a real iPhone) is wanted, say so: it is a policy change and gets its own review first.
