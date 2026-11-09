# CP-TRAINING — the training instance (T1)

Written 2026-11-04. A copy of KAYAS for hands-on training of the office staff, the drivers and the owner, with **fictitious data only**.
**Current policy (R15A-06): the training instance runs LOCAL ONLY, on one Mac, at `http://localhost:3000`. Nothing is public and there is no tunnel**
(no Tailscale Funnel or Serve, no reverse proxy, no port forwarding, no public profile of the compose file). The public helpers of the earlier
plan (`go-public.sh`, the Funnel check) are removed. The operator is responsible for the machine having no publisher: the startup scripts do not
inspect and do not vouch for it (see step 8). It is **not** a launch:
the final review (`docs/reviews/CODEX-REVIEW-FINAL.md`) still stands for real data (Batch D, paused: see CP-PROD-PLAN.md).

## What "training mode" is (`TRAINING_MODE=true`)
- **Guard.** The server refuses to start without a completed training seed on its database (the marker) when `TRAINING_MODE=true`, and the seed only fills an empty, unmarked database (a failed seed leaves one that is refused: remove the volume with `./scripts/training/dc.sh down -v` and start again). The server refuses to start with `TRAINING_MODE=true` next to `APP_ENV=production` or `REAL_DATA=true`; and a database that holds the training
  seed (a marker row, migration 0111) refuses to start without `TRAINING_MODE=true`. A boot warning is logged if the configured address looks like a Tailscale
  (`*.ts.net`) address while training mode is off.
- **Data.** `seed:training`: two plants (Tétouan, Chefchaouen); trucks 4 × 16 m³ (Tétouan), 4 × 11 m³ and 1 × 10 m³ (Chefchaouen); 3 pumps; recipes and
  reference prices per plant; fictitious clients and suppliers with fake ICE (`000000000000…`) and fake phones (`06000000xx`), a cement supplier "Ciment Démo";
  orders in every state, cheques and payments, invoices, rotations, receipts, transfers (the pilot scenario dated from today, plus data for both plants).
- **Accounts.** One per role (owner, app_admin, office_sales, office_purchases, two plant managers, accountant, three drivers, one pump operator). Random
  passwords and 6-digit PINs are written **once** to `/app/out/training-accounts.local.txt` inside a Docker volume (`accounts`, folder mode 0700 owned by the container user, no folder of the checkout; file mode 0600, created exclusively then renamed, name covered by the ignore rules of git and of the image; the seed stops without marking the database if it cannot be written) and never printed or logged.
  Read them one trainee at a time with `./scripts/training/show-accounts.sh <exact login or code>` (no argument lists the names only; zero or several matches are refused).
- **Sign-in.** The accounts on the reserved address `…@formation.kayas.invalid` work with their **password alone** (no authenticator), only while training
  mode is on. Everything else is unchanged: roles and permissions, row-level security, the audit log, money visibility, the **rate limiting and the login
  lockout stay on** (they are not relaxed for training). Drivers and the pump operator sign in on the phone with their code and PIN (five wrong PINs lock them 15 minutes, attempts are serialised per driver, and the sign-in endpoint has a per-IP limit).
- **Banner.** A red banner on every page, in the user's language: « Version de formation — données fictives » / « نسخة تدريب — معطيات وهمية ».
- **Nothing goes out, nothing comes in.** Imports are refused entirely (`import:excel` stops; a fictitious database is only ever filled by the seed), map links are
  not built, web push is off (the phone push endpoints answer 404, no subscription button is shown, and VAPID keys are refused at startup), and a language model (`ASSISTANT_PROVIDER=anthropic`, a key, invoice reading) is refused at startup. (There is no WhatsApp/SMS in the code.)
- **Modules.** Every module flag that exists is on: field app, notifications, cancellations, documents V1, Darija, deterministic assistant, transfers, finance.
- **Finance asks for a REAL authenticator, even in training.** The password-only exception does not reach finance: its endpoints and pages check the user's real `twoFactorEnabled`. The seed switches the finance module on in the database. The owner, the app_admin and the accountant therefore have a choice: practise without finance (password alone), or enrol a real authenticator app on their phone from the red banner (« Activer l'authentification à deux facteurs », page `/enrol`, their password, the QR code, one code). From then on that account signs in with password + code like in production, and finance reads, writes and exports work (proved by `tests/training-finance.int.test.ts`). Nobody else can enrol voluntarily (the `/enrol` page itself sends any other training account home, and the QR code is made on our server for those three roles only; proved in a real browser by `e2e/training.spec.ts`, R12-07), no finance role is widened, and a reset of the training data (`training-reset.sh`) gives the account back its password-only state.
  The client and supplier portals have no flag and stay off. The external assistant stays off (it is refused in a production build).

## What the iMac needs
| | |
|---|---|
| Machine | Intel iMac (2019) runs `linux/amd64` natively: no emulation. On Apple Silicon the compose file pins `platform: linux/amd64` on `db`, `app` and `ops`, so the stack starts without `DOCKER_DEFAULT_PLATFORM` (it runs under emulation: slower, fine for training). |
| Memory | **8 GB free**; 4 GB go to the Colima virtual machine. |
| Disk | **20 GB free** (the image, the database, 14 nightly dumps). |
| Never sleeps | `sudo pmset -a sleep 0 disksleep 0 displaysleep 15` (the screen may sleep; the machine may not). |
| Starts after a power cut | `sudo pmset -a autorestart 1` and System Settings → Energy → "Start up automatically after a power failure". |
| Network | **Ethernet** if possible (Wi-Fi works but drops more). Give the iMac a fixed address in the router if you can. |
| Disk encryption | **Keep FileVault ON and automatic login OFF.** The iMac holds the app secrets, the training owner's credentials, and a registry token: treat it as a credential-bearing host, with a password on the operator account and a screen lock. The price is that after a power cut nothing starts until somebody types the password at the FileVault screen: plan for it (tell the trainees the instance may be down until you unlock the iMac). Do not trade this for convenience. |
| Updates | Disable automatic restart for macOS updates (`sudo softwareupdate --schedule off`); restart it yourself on a quiet evening. |

A short version in French for a non-expert, with what to see at each step, is in `CP-TRAINING-IMAC-FR.md`.

## Step by step, on the iMac (what Ali does himself)
Nothing here is done for you, and no token or password is ever pasted anywhere but into the Terminal prompt that asks for it.

1. **Open Terminal** (Applications → Utilities → Terminal). Set the power settings of the table above.
2. **Install the tools** (Homebrew first, from <https://brew.sh>, if the iMac has none):
   `brew install colima docker docker-compose git gh`
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
   <http://127.0.0.1:3000/fr/login> on the Mac itself (or <http://localhost:3000/fr/login> after `set-url.sh http://localhost:3000`, step 8): the red training banner must show. Give each trainee only their own line:
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
   database that carries the training marker; the helper itself checks the mode (training on, not production, real data off) and that the cluster has a birth row **bound to that
   very database name** (R15A-07: a spent row with no name, made by an earlier version, is refused, because it never identified any database), and then mints a new marker bound to it.
   Prefer a fresh volume. If you have verified yourself that a legacy volume is dedicated to this one database and want to keep it, you may bind its row deliberately, as the
   database superuser in the maintenance database `postgres`: `update public.volume_birth set database_name = 'belgobeton_training' where database_name is null;` (add the column first with
   `alter table public.volume_birth add column if not exists database_name text;` on a very old volume). This is an operator decision, not something any script does for you. The only skip of the marker is for the throwaway test databases and needs a positive test-runner signal as well as the
   database name; no deployed command offers it. Migrations: all of them, 132 files (0000 to 0122, then 0200 to 0208: the finance ones and the T8 role hardening), applied by `training-up.sh`.
8. **Local only: nothing is published (R15A-06).** The instance is used on THIS Mac, in its browsers, at `http://localhost:3000`. The app accepts writes only from the exact address in
   `APP_BASE_URL`, and `init-env.sh` writes `http://127.0.0.1:3000` by default: run `./scripts/training/set-url.sh http://localhost:3000` once so that the address you type is the
   one the app expects (`set-url.sh` accepts local addresses only). The app socket is bound to the loopback address
   (`127.0.0.1`) and the database has no host port. **No tunnel, no Tailscale Funnel or Serve, no reverse proxy, no port forwarding, no `--profile public`.**
   **The operator is responsible for the Mac having no publisher.** Neither `training-up.sh` nor any other script inspects Tailscale or any other tunnel, and a successful start
   says nothing about it. Before the first session, and again after every reboot, look for yourself that nothing publishes this machine: no tunnel client or
   service running (check the Mac's list of login items and background services, and your router has no forward to it), and a request to the Mac's
   address from another device is refused. If you ever find one, stop the exercise, remove it, and reset the training data.
   **Phones.** The phone screen is exercised in a browser on this Mac (a narrow window or the browser's device mode), not on a real phone over a network.
   **Operating rule for the phone screen (R15A):** use a SEPARATE BROWSER PROFILE for each training identity (one driver per profile); never hand a phone over by signing
   out and signing in again in the same live page; close the old page or profile before another person starts; and if anything is stuck (a sign-out that does not finish,
   a photo that stays waiting, a day that does not clear), STOP that profile's exercise instead of carrying on over a stuck session. Use synthetic images only.
9. **Nightly dump** (outside the repository, 14 kept): `crontab -e` and add
   `30 2 * * * cd $HOME/belgobeton && ./scripts/training-backup.sh >> $HOME/kayas-training-backup.log 2>&1`
   The dump is the **database only** (no attachments, no keys): it brings back the database on THIS host, with the same `.env.training` files and the same
   `filestore` volume, and nowhere else. Restore one (stop the app first): `./scripts/training/dc.sh stop app`, then
   `./scripts/training/dc.sh exec -T db pg_restore -U postgres -d belgobeton --clean --if-exists < ~/kayas-training-backups/training-<stamp>.dump`, then `./scripts/training/dc.sh up -d app`.

## Day to day
- Stop: `./scripts/training-down.sh` (data kept). Start: `./scripts/training-up.sh`.
- Nothing is public (step 8): there is no address to close. When nobody is training, `./scripts/training-down.sh` stops the instance.
- **Re-arm the day** (under a minute, accounts and passwords untouched): `./scripts/training-rearm.sh` creates today's orders, plans the three drivers' rotations in sequence, adds quotes, an order to cancel, a delivery to receive and a low-stock alert, dated from today (it cancels the day's unproduced Tétouan orders first, so it can be run again). Run it each morning before a session. The exercise cards per role are in `docs/training/`. **It must run BEFORE trainees sign in, and it is not all-or-nothing**: it cancels every eligible unproduced Tétouan order due today (not only the ones it created) in several transactions, so an interrupted run can leave a half re-armed day (run it again, or reset).
- **Reset to the clean seed** (erases everything entered, new passwords): `./scripts/training-reset.sh` (asks you to type RESET), then `./scripts/training/show-accounts.sh <name>` for each trainee.
  It only ever wipes a database that carries the training marker.
- **New version:** `git pull`, then `./scripts/training/pick-image.sh` (the digest of the green build of exactly that commit), replace the `APP_IMAGE=` line in `.env.training` with it, run `./scripts/training-up.sh` (it migrates and waits for readiness).
- Never enter a real client, a real phone number or a real cheque. The instance has no CNDP declaration and no hardening review behind it.

## What was checked, what was not
Checked by tests: the startup guard (including the database marker and the `*.ts.net` boot warning), the seed on a scratch database (counts, sizes of trucks, fake identifiers,
one account per role, credentials only in the file, not in the logs or in clear in the database), the reset (new credentials, refusal on an unmarked database), the
password-only sign-in (only on the reserved address, only in training mode), the banner (fr and ar, on a real second server), the import refusal, the outbound switches,
the compose file (loopback only, no maintenance login in the app), the scripts (against stubs) and `init-env.sh` (real files accepted by the environment check).
**Not checked here:** a start on a real Docker host, Colima on the iMac, that the Mac really has no publisher (the scripts do not look), and the nightly job. Rehearse steps 3 to 9 once, then train.

## December: the same files on a VPS (outside the current policy)
This is NOT part of the local-only policy above and needs its own review before anything is published. Nothing changes in `docker-compose.training.yml`. On the VPS: install Docker, `docker login ghcr.io` the same way, clone, run `init-env.sh` with
`APP_BASE_URL=https://<domain>`, put `APP_DOMAIN=<domain>` in `.env.training`, start with `./scripts/training/dc.sh --profile public up -d` (Caddy takes ports 80 and 443
and gets the certificate; the app stays on 127.0.0.1), and point the domain's A and AAAA records at the VPS.
**The VPS starts with a fresh training seed, and what the trainees entered on the iMac is discarded.** There is no "restore last night's dump on the VPS"
promise: the dump holds the database only, while attachments (photos of signed BLs, supplier files) are in the separate `filestore` volume and every
personal field and every upload is encrypted with the keys generated by `init-env.sh` on that host (a new host makes new keys, so a dump moved alone has rows
without files and fields it cannot decrypt). The dump also contains session tokens and password and PIN hashes: it is not for sharing. Moving the work
properly would need the dump, the `filestore` volume and the secret files carried together through a separate, secure process that nobody has rehearsed;
until that is written and rehearsed, plan a new seed and new credentials, and tell the trainees before the move.
The production instance is another matter: it uses `docker-compose.prod.yml`, `APP_ENV=production`
and the runbook, and it cannot be started with training mode or on a training database.

## Mandatory conditions before a supervised local exercise (R12, reduced to the local-only policy by R15A-06)
`docs/reviews/CODEX-REVIEW-R12.md` gave a conditional GO for supervised training with fictitious data only, and `docs/reviews/CODEX-REVIEW-R15A.md` keeps it for supervised
local exercises on one Mac. The conditions below are mandatory; record each one (without any secret) on the Mac before a session.
1. **Approved artifact and fresh volume.** A clean checkout of the reviewed commit and the digest of ITS successful image workflow (`pick-image.sh`); the running
   app and ops use that digest. All 132 migrations applied (0000 to 0122 and 0200 to 0208; the birth token of step 7 is still unused when the seed starts and consumed by it). The stock `belgobeton-training` project on a genuinely NEW dedicated
   database volume initialised by the training seed: no import, no partial restore, no reused business database, no hand-inserted marker, no database left from an older version
   whose birth row has no name (a reset refuses it). Keep evidence that the volume was created and the seed completed.
2. **Mode and credential isolation.** In the RUNNING app: training on, real data and simulation off, `APP_ENV=training`, `TRAINING_ALLOW_UNMARKED` absent or
   false (the compose file forces it off and the environment check refuses it outside the test runner), no VAPID or provider credentials, the red banner. No
   maintenance, superuser or seed credentials and no accounts volume in the app. The credentials stay in the stock private volume only (`/app/out`: uid 10001,
   folder 0700, file 0600, checked by metadata). Never run the seed with a local or custom output path in a checkout (the seed refuses one). Use a
   trusted, non-shared checkout and an exclusive operator account for `init-env.sh` and the scripts that rewrite secrets. One operator seeds and resets; never start a
   second seed or a reset while a previous one could still resume.
3. **Handling the credentials.** FileVault on, automatic login off, screen lock on. Docker really uses the Keychain helper, the token is `read:packages` only, the
   GHCR package is private. Give each trainee exactly their own block with `show-accounts.sh <exact login or code>`, check that ONE block is shown, never
   record, photograph or redirect it. Reset any credential whose handling is uncertain: the business data is fictitious, the credentials are not.
4. **Local only, checked by the operator.** The app on the loopback port only (`127.0.0.1:3000`), no host database port, `APP_BASE_URL` a local address (`http://localhost:3000`), no tunnel or
   publisher on the Mac (step 8; the scripts do not check this and nothing they print is evidence of it).
5. **Phone sign-in.** Parallel wrong PINs cannot exceed the per-driver five-failure lock; a correct PIN after the lock does not clear it; the bound, foreign and released
   phone cases behave. (The per-IP limit is exercised by its tests; locally every request comes from the same address.)
6. **Roles, offline and finance acceptance.** Unauthorised direct requests and wrong-origin writes are refused; the two plant managers are separated; logout and
   device revocation work; an empty-queue phone revalidates; the day leaves the screen at expiry even when the network stalls. Separate browser profiles, one per identity,
   and the operating rule of step 8; do not describe the 18 hours as a proven confidentiality boundary. Finance: password-only
   is refused, the owner, app_admin or accountant enrols a real authenticator (QR or manual key), a real fresh code makes writes work, the accountant exports.
   No synthetic-factor finance exception exists.
7. **Supervision and closure.** Only supervised sessions, with no real client, supplier, cheque, document or photo. Stop the instance when nobody is training
   (`training-down.sh`). The nightly dumps are same-host, database-only recovery, not a portable backup.
