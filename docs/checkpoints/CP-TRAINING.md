# CP-TRAINING — the training instance (T1)

Written 2026-11-04. A copy of BELGOBETON for hands-on training of the office staff, the drivers and the owner, with **fictitious data only**.
It runs on a dedicated Intel 2019 iMac (not the development MacBook, not a VPS), is reached over the internet through a **Tailscale Funnel**
(a stable `https://….ts.net` address, no router change, no domain), and the same files move to a VPS in December. It is **not** a launch:
the final review (`docs/reviews/CODEX-REVIEW-FINAL.md`) still stands for real data (Batch D, paused: see CP-PROD-PLAN.md).

## What "training mode" is (`TRAINING_MODE=true`)
- **Guard.** The server refuses to start without a completed training seed on its database (the marker) when `TRAINING_MODE=true`, and the seed only fills an empty, unmarked database (a failed seed leaves one that is refused: remove the volume with `./scripts/training/dc.sh down -v` and start again). The server refuses to start with `TRAINING_MODE=true` next to `APP_ENV=production` or `REAL_DATA=true`; and a database that holds the training
  seed (a marker row, migration 0111) refuses to start without `TRAINING_MODE=true`. A boot warning is logged if the public address looks like a Tailscale
  address while training mode is off; `scripts/training/funnel-check.sh` (run by `training-up.sh`) warns, from outside the container, if the Funnel is up
  while the app is not in training mode.
- **Data.** `seed:training`: two plants (Tétouan, Chefchaouen); trucks 4 × 16 m³ (Tétouan), 4 × 11 m³ and 1 × 10 m³ (Chefchaouen); 3 pumps; recipes and
  reference prices per plant; fictitious clients and suppliers with fake ICE (`000000000000…`) and fake phones (`06000000xx`), a cement supplier "Ciment Démo";
  orders in every state, cheques and payments, invoices, rotations, receipts, transfers (the pilot scenario dated from today, plus data for both plants).
- **Accounts.** One per role (owner, app_admin, office_sales, office_purchases, two plant managers, accountant, three drivers, one pump operator). Random
  passwords and 6-digit PINs are written **once** to `/app/out/training-accounts.local.txt` inside a Docker volume (`accounts`, folder mode 0700 owned by the container user, no folder of the checkout; file mode 0600, created exclusively then renamed, name covered by the ignore rules of git and of the image; the seed stops without marking the database if it cannot be written) and never printed or logged.
  Read them one trainee at a time with `./scripts/training/show-accounts.sh <exact login or code>` (no argument lists the names only; zero or several matches are refused).
- **Sign-in.** The accounts on the reserved address `…@formation.beton.invalid` work with their **password alone** (no authenticator), only while training
  mode is on. Everything else is unchanged: roles and permissions, row-level security, the audit log, money visibility, the **rate limiting and the login
  lockout stay on** (the instance is on the internet). Drivers and the pump operator sign in on the phone with their code and PIN (five wrong PINs lock them 15 minutes, attempts are serialised per driver, and the sign-in endpoint has a per-IP limit).
- **Banner.** A red banner on every page, in the user's language: « Version de formation — données fictives » / « نسخة تدريب — معطيات وهمية ».
- **Nothing goes out, nothing comes in.** Imports are refused entirely (`import:excel` stops; a fictitious database is only ever filled by the seed), map links are
  not built, web push is off (the phone push endpoints answer 404, no subscription button is shown, and VAPID keys are refused at startup), and a language model (`ASSISTANT_PROVIDER=anthropic`, a key, invoice reading) is refused at startup. (There is no WhatsApp/SMS in the code.)
- **Modules.** Every module flag that exists is on: field app, notifications, cancellations, documents V1, Darija, deterministic assistant, transfers, finance.
- **Finance asks for a REAL authenticator, even in training.** The password-only exception does not reach finance: its endpoints and pages check the user's real `twoFactorEnabled`. The seed switches the finance module on in the database. The owner, the app_admin and the accountant therefore have a choice: practise without finance (password alone), or enrol a real authenticator app on their phone from the red banner (« Activer l'authentification à deux facteurs », page `/enrol`, their password, the QR code, one code). From then on that account signs in with password + code like in production, and finance reads, writes and exports work (proved by `tests/training-finance.int.test.ts`). Nobody else can enrol voluntarily (the `/enrol` page itself sends any other training account home, and the QR code is made on our server for those three roles only; proved in a real browser by `e2e/training.spec.ts`, R12-07), no finance role is widened, and a reset of the training data (`training-reset.sh`) gives the account back its password-only state.
  The client and supplier portals have no flag and stay off. The external assistant stays off (it is refused in a production build).

## What the iMac needs
| | |
|---|---|
| Machine | Intel iMac (2019) runs `linux/amd64` natively: no emulation. |
| Memory | **8 GB free**; 4 GB go to the Colima virtual machine. |
| Disk | **20 GB free** (the image, the database, 14 nightly dumps). |
| Never sleeps | `sudo pmset -a sleep 0 disksleep 0 displaysleep 15` (the screen may sleep; the machine may not). |
| Starts after a power cut | `sudo pmset -a autorestart 1` and System Settings → Energy → "Start up automatically after a power failure". |
| Network | **Ethernet** if possible (Wi-Fi works but drops more). Give the iMac a fixed address in the router if you can. |
| Disk encryption | **Keep FileVault ON and automatic login OFF.** The iMac holds the app secrets, the training owner's credentials, a registry token and the Tailscale identity: treat it as a credential-bearing host, with a password on the operator account and a screen lock. The price is that after a power cut nothing starts until somebody types the password at the FileVault screen: plan for it (tell the trainees the instance may be down until you unlock the iMac). Do not trade this for convenience. |
| Updates | Disable automatic restart for macOS updates (`sudo softwareupdate --schedule off`); restart it yourself on a quiet evening. |

A short version in French for a non-expert, with what to see at each step, is in `CP-TRAINING-IMAC-FR.md`.

## Step by step, on the iMac (what Ali does himself)
Nothing here is done for you, and no token or password is ever pasted anywhere but into the Terminal prompt that asks for it.

1. **Open Terminal** (Applications → Utilities → Terminal). Set the power settings of the table above.
2. **Install the tools** (Homebrew first, from <https://brew.sh>, if the iMac has none):
   `brew install colima docker docker-compose git gh tailscale`
3. **Start the Docker engine** (4 GB, amd64) and have it start at every login:
   `colima start --arch x86_64 --cpu 2 --memory 4 --disk 40` then `brew services start colima`.
   Check: `docker info` answers without an error.
4. **Get the code.** `gh auth login` (choose GitHub.com, HTTPS, "Login with a web browser"; the browser does the work, you paste nothing), then
   `gh repo clone aliescoobs-sudo/beton ~/belgobeton && cd ~/belgobeton`.
5. **Let the iMac pull the private image** (GHCR). On github.com: your picture → Settings → Developer settings → Personal access tokens → **Tokens (classic)**
   → Generate new token (classic) → note "training iMac", expiry 90 days, tick **only `read:packages`** (read-only: never write or delete) → Generate. Copy it
   (you see it once). **First make Docker keep registry credentials in the macOS Keychain, not in a file:** `brew install docker-credential-helper`, then check
   that `~/.docker/config.json` says `"credsStore": "osxkeychain"` (add it if it is missing; `docker-credential-osxkeychain version` must answer). Only then, in the
   Terminal: `docker login ghcr.io -u aliescoobs-sudo` — when it asks **Password:** paste the token there (nothing shows as you paste) and press Return.
   Check that the token did not land in a file: `grep -c '"auth"' ~/.docker/config.json` must print `0`. If it prints more, run `docker logout ghcr.io`, delete the
   token on github.com and fix the helper before going on. Do not put the token anywhere else; if it is ever shown in a chat or a file, delete it on github.com.
6. **Pick the image, tied to your commit.** The code you run and the image must be the same commit: `APP_IMAGE=$(./scripts/training/pick-image.sh) ./scripts/training/init-env.sh`.
   `pick-image.sh` takes `git rev-parse HEAD`, finds the **green** run of **Build and publish image** for that exact commit (GitHub CLI), reads the digest that run
   printed with its commit, refuses if there is none or if it names another commit (never simply the newest green build: it can be another commit), and prints
   `ghcr.io/…/belgobeton@sha256:…` on stdout and the commit on stderr. `init-env.sh` then writes the two secret files (random secrets, mode 600, not printed).
7. **Start it:** `./scripts/training-up.sh` (the first run takes a few minutes: image, database, roles, structure, training data). Open
   <http://127.0.0.1:3000/fr/login> on the iMac itself: the red training banner must show. Give each trainee only their own line:
   `./scripts/training/show-accounts.sh` lists the account names (no secret), `./scripts/training/show-accounts.sh <exact login or code>` (e.g. `CH-02`, `comptable`) shows one block; a generic word or the shared domain matches several accounts and is refused before anything secret is printed. Hand it over in
   person, then clear the screen and its history (Command-K). Never circulate the whole list: no screenshot, no message, no `script` or other terminal recording,
   no redirection of the output to a file (`--all` exists for the rare case you need everything, and says so).
   **Fresh volume and the birth marker (R13-01, R14-13).** The first time the stack is started, the postgres image runs `scripts/training/db-init/10-birth-token.sql` (mounted
   read-only into the database container) **once**, on the brand-new volume: it writes one *birth marker* into the cluster's maintenance database. `seed:training` needs it,
   binds it to the business database name and uses it up (atomically) before it writes anything. **What this proves, and what it does not.** It refuses the ordinary
   mistakes: a database restored or hand-built on a cluster that never had the marker, a second seed on the same volume, a seed for another database name. It is a
   consumable marker, **not** a signed token or an attestation: whoever can restore the maintenance database, a whole cluster or a physical snapshot can carry an *unused*
   marker into another cluster, and a superuser can write one; a completed business dump can also carry the training marker. **A successful seed is therefore not proof that the
   volume is new.** Establishing that the volume is fresh and dedicated stays your own check, outside this code. The seed also proves the database empty without statistics:
   every table of `public` and `finance` must have an empty heap file, or be read exactly with the maintenance login not subject to row-level security; a table that has been
   written to and whose rows row-level security may hide from that login **fails closed**. An OLD training volume cannot be seeded again: remove it
   (`./scripts/training/dc.sh down -v`, which also erases the accounts file and the file store) and run `training-up.sh` again. `reset:training` is the operator's own reset of a
   database that carries the training marker; the helper itself checks the mode (training on, not production, real data off) and that the cluster has a birth row for that
   database, and then mints a new marker bound to it. The only skip of the marker is for the throwaway test databases and needs a positive test-runner signal as well as the
   database name; no deployed command offers it. Migrations: all of them through 0118, plus the finance ones.
8. **Make it public with Tailscale Funnel: last, and in this order.**
   a. `sudo brew services start tailscale` then `sudo tailscale up` — it prints a link: open it, sign in (create the free Tailscale account), approve the machine.
   b. In the Tailscale admin console (<https://login.tailscale.com/admin>): **DNS** → turn on **MagicDNS** and **HTTPS Certificates**. The console shows the
      machine name: the address will be `https://<machine>.<your-tailnet>.ts.net` (nothing is public yet).
   c. Tell the app its public address **first** (it only accepts writes coming from it): `./scripts/training/set-url.sh https://<machine>.<tailnet>.ts.net`.
   d. `./scripts/training/go-public.sh https://<machine>.<tailnet>.ts.net` — the only step that opens the Funnel. **It first runs `tailscale funnel reset` and reads the status back: if the reset fails or the status is not clearly closed, it stops with `CLOSURE UNCONFIRMED — check Tailscale manually` and a non-zero status (close it through Tailscale yourself, then check from outside). After opening it validates the COMPLETE status (the structured one when the CLI offers it): exactly one HTTPS proxy to the app's loopback endpoint, any other entry refuses and closes. It never prints "closed" without having read the closed state back (R13-04).** It refuses unless the app was told this very address,
      runs in training mode and answers its readiness check (database and migrations), then runs `tailscale funnel --bg <the app's real port>`. If Tailscale says Funnel is
      not allowed it prints a link to enable it for this machine: open it, accept, run `go-public.sh` again. (`funnel-check.sh`, run by `training-up.sh`, only warns if a
      Funnel points at another port or machine; it never authorises anything.)
   e. Test from a phone on mobile data (not the home Wi-Fi) the **whole** path over the real HTTPS address: the login page with the red banner, sign in with a training
      account, make one change, sign out. Then `tailscale funnel reset` and check that the address no longer answers. Open it again with `go-public.sh` when the training starts.
9. **Nightly dump** (outside the repository, 14 kept): `crontab -e` and add
   `30 2 * * * cd $HOME/belgobeton && ./scripts/training-backup.sh >> $HOME/belgobeton-training-backup.log 2>&1`
   The dump is the **database only** (no attachments, no keys): it brings back the database on THIS host, with the same `.env.training` files and the same
   `filestore` volume, and nowhere else. Restore one (stop the app first): `./scripts/training/dc.sh stop app`, then
   `./scripts/training/dc.sh exec -T db pg_restore -U postgres -d belgobeton --clean --if-exists < ~/belgobeton-training-backups/training-<stamp>.dump`, then `./scripts/training/dc.sh up -d app`.

## Day to day
- Stop: `./scripts/training-down.sh` (data kept). Start: `./scripts/training-up.sh`.
- **Stop the Funnel** (the public address closes at once): `tailscale funnel reset`. Do this whenever nobody is training.
- **Re-arm the day** (under a minute, accounts and passwords untouched): `./scripts/training-rearm.sh` creates today's orders, plans the three drivers' rotations in sequence, adds quotes, an order to cancel, a delivery to receive and a low-stock alert, dated from today (it cancels the day's unproduced Tétouan orders first, so it can be run again). Run it each morning before a session. The exercise cards per role are in `docs/training/`.
- **Reset to the clean seed** (erases everything entered, new passwords): `./scripts/training-reset.sh` (asks you to type RESET), then `./scripts/training/show-accounts.sh <name>` for each trainee.
  It only ever wipes a database that carries the training marker.
- **New version:** `git pull`, then `./scripts/training/pick-image.sh` (the digest of the green build of exactly that commit), replace the `APP_IMAGE=` line in `.env.training` with it, run `./scripts/training-up.sh` (it migrates and waits for readiness).
- Never enter a real client, a real phone number or a real cheque. The instance has no CNDP declaration and no hardening review behind it.

## What was checked, what was not
Checked by tests: the startup guard (including the database marker and the Funnel warning), the seed on a scratch database (counts, sizes of trucks, fake identifiers,
one account per role, credentials only in the file, not in the logs or in clear in the database), the reset (new credentials, refusal on an unmarked database), the
password-only sign-in (only on the reserved address, only in training mode), the banner (fr and ar, on a real second server), the import refusal, the outbound switches,
the compose file (loopback only, no maintenance login in the app), the scripts (against stubs) and `init-env.sh` (real files accepted by the environment check).
**Not checked here:** a start on a real Docker host, Colima on the iMac, Tailscale Funnel itself and the nightly job. Rehearse steps 3 to 9 once, then train.

## December: the same files on a VPS
Nothing changes in `docker-compose.training.yml`. On the VPS: install Docker, `docker login ghcr.io` the same way, clone, run `init-env.sh` with
`APP_BASE_URL=https://<domain>`, put `APP_DOMAIN=<domain>` in `.env.training`, start with `./scripts/training/dc.sh --profile public up -d` (Caddy takes ports 80 and 443
and gets the certificate; the app stays on 127.0.0.1), point the domain's A and AAAA records at the VPS, and close the Funnel on the iMac.
**The VPS starts with a fresh training seed, and what the trainees entered on the iMac is discarded.** There is no "restore last night's dump on the VPS"
promise: the dump holds the database only, while attachments (photos of signed BLs, supplier files) are in the separate `filestore` volume and every
personal field and every upload is encrypted with the keys generated by `init-env.sh` on that host (a new host makes new keys, so a dump moved alone has rows
without files and fields it cannot decrypt). The dump also contains session tokens and password and PIN hashes: it is not for sharing. Moving the work
properly would need the dump, the `filestore` volume and the secret files carried together through a separate, secure process that nobody has rehearsed;
until that is written and rehearsed, plan a new seed and new credentials, and tell the trainees before the move.
The production instance is another matter: it uses `docker-compose.prod.yml`, `APP_ENV=production`
and the runbook, and it cannot be started with training mode or on a training database.

## Mandatory conditions before the Funnel is opened (R12)
`docs/reviews/CODEX-REVIEW-R12.md` gives a conditional GO for supervised web-and-phone training with fictitious data only. All seven conditions are
mandatory; record each one (without any secret) before `go-public.sh`. Funnel stays closed until all seven are recorded on the actual iMac.
1. **Approved artifact and fresh volume.** A clean checkout of the reviewed commit and the digest of ITS successful image workflow (`pick-image.sh`); the running
   app and ops use that digest. All migrations applied (through 0118 and the finance ones; the birth token of step 7 is still unused when the seed starts and consumed by it). The stock `belgobeton-training` project on a genuinely NEW dedicated
   database volume initialised by the training seed: no import, no partial restore, no reused business database, no hand-inserted marker. Keep evidence that the
   volume was created and the seed completed.
2. **Mode and credential isolation.** In the RUNNING app: training on, real data and simulation off, `APP_ENV=training`, `TRAINING_ALLOW_UNMARKED` absent or
   false (the compose file forces it off and the environment check refuses it outside the test runner), no VAPID or provider credentials, the red banner. No
   maintenance, superuser or seed credentials and no accounts volume in the app. The credentials stay in the stock private volume only (`/app/out`: uid 10001,
   folder 0700, file 0600, checked by metadata). Never run the seed with a local or custom output path in a checkout (the seed now refuses one). Use a
   trusted, non-shared checkout and an exclusive operator account for `init-env.sh` and the scripts that rewrite secrets.
3. **Handling the credentials.** FileVault on, automatic login off, screen lock on. Docker really uses the Keychain helper, the token is `read:packages` only, the
   GHCR package is private. Give each trainee exactly their own block with `show-accounts.sh <exact login or code>`, check that ONE block is shown, never
   record, photograph or redirect it. Reset any credential whose handling is uncertain: the business data is fictitious, the credentials are not.
4. **Close, configure, verify, publish.** `tailscale funnel reset` first, and confirm from outside that the address is closed. No host database port; the app on
   the expected loopback port only. `set-url.sh <https address>`, restart, then `go-public.sh <https address>`: it re-resets, reads the port and the address
   from the RUNNING app, requires the training readiness answer from that very socket and exactly one proxy target in the full Funnel status. A stale env file,
   a ready container that is not the one on the port, or a silent check is not enough. Then a short supervised check from mobile data.
5. **Phone sign-in acceptance on the real proxy.** Parallel wrong PINs cannot exceed the per-driver five-failure lock; a correct PIN after the lock does not clear
   it; the bound, foreign and released phone cases behave. The per-IP limit locks an address through the actual Funnel, a forged or malformed
   `X-Forwarded-For` does not change or disable the client address selected, and an unknown address falls in one shared bucket. Accept only the remaining
   burst and availability risk, with an operator ready to close the Funnel. If the trusted-IP behaviour or the per-driver lock cannot be shown, the phone
   app is not exposed.
6. **Roles, offline and finance acceptance.** Unauthorised direct requests and wrong-origin writes are refused; the two plant managers are separated; logout and
   device revocation work; an empty-queue phone revalidates; the day leaves the screen at expiry even when the network stalls. Locked, dedicated phones;
   sign out and clear the local day and queued photos at handover; do not describe the 18 hours as a proven confidentiality boundary. Finance: password-only
   is refused, the owner, app_admin or accountant enrols a real authenticator (QR or manual key), a real fresh code makes writes work, the accountant exports.
   No synthetic-factor finance exception exists.
7. **Supervision and closure.** Open it only during a supervised session, with no real client, supplier, cheque, document or photo. Complete login, a change and
   logout over HTTPS from mobile data, web and phone. Reset the Funnel afterwards and confirm from outside that it is closed; repeat after any interruption or
   reboot (`--bg` persists). The nightly dumps are same-host, database-only recovery, not a portable backup; the December VPS starts with a fresh seed.
