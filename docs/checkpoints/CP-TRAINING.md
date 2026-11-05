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
  Read them with `./scripts/training/show-accounts.sh`.
- **Sign-in.** The accounts on the reserved address `…@formation.beton.invalid` work with their **password alone** (no authenticator), only while training
  mode is on. Everything else is unchanged: roles and permissions, row-level security, the audit log, money visibility, the **rate limiting and the login
  lockout stay on** (the instance is on the internet). Drivers and the pump operator sign in on the phone with their code and PIN (five wrong PINs lock them 15 minutes, attempts are serialised per driver, and the sign-in endpoint has a per-IP limit).
- **Banner.** A red banner on every page, in the user's language: « Version de formation — données fictives » / « نسخة تدريب — معطيات وهمية ».
- **Nothing goes out, nothing comes in.** Imports are refused entirely (`import:excel` stops; a fictitious database is only ever filled by the seed), map links are
  not built, web push is off (the phone push endpoints answer 404, no subscription button is shown, and VAPID keys are refused at startup), and a language model (`ASSISTANT_PROVIDER=anthropic`, a key, invoice reading) is refused at startup. (There is no WhatsApp/SMS in the code.)
- **Modules.** Every module flag that exists is on: field app, notifications, cancellations, documents V1, Darija, deterministic assistant, transfers, finance.
- **Finance asks for a REAL authenticator, even in training.** The password-only exception does not reach finance: its endpoints and pages check the user's real `twoFactorEnabled`. The seed switches the finance module on in the database. The owner, the app_admin and the accountant therefore have a choice: practise without finance (password alone), or enrol a real authenticator app on their phone from the red banner (« Activer l'authentification à deux facteurs », page `/enrol`, their password, the QR code, one code). From then on that account signs in with password + code like in production, and finance reads, writes and exports work (proved by `tests/training-finance.int.test.ts`). Nobody else can enrol voluntarily, no finance role is widened, and a reset of the training data (`training-reset.sh`) gives the account back its password-only state.
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
| Sign-in at boot | Turn off FileVault, or turn on automatic login, otherwise nothing starts after a power cut until someone types the password. |
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
   → Generate new token (classic) → note "training iMac", expiry 90 days, tick **only `read:packages`** → Generate. Copy it (you see it once). In the Terminal:
   `docker login ghcr.io -u aliescoobs-sudo` — when it asks **Password:** paste the token there (nothing shows as you paste) and press Return. Do not put it
   anywhere else. If the token is ever shown in a chat or a file, delete it on github.com and make another.
6. **Pick the image.** github.com → the repository → Actions → the latest green run of **Build and publish image** → its summary shows the **Digest to deploy**
   (`sha256:…`). Then create the two secret files (random secrets, mode 600, not printed):
   `APP_IMAGE=ghcr.io/aliescoobs-sudo/belgobeton@sha256:<the digest> ./scripts/training/init-env.sh`
7. **Start it:** `./scripts/training-up.sh` (the first run takes a few minutes: image, database, roles, structure, training data). Open
   <http://127.0.0.1:3000/fr/login> on the iMac itself: the red training banner must show. Read the accounts once: `./scripts/training/show-accounts.sh`
   and hand each person their line in person.
8. **Make it public with Tailscale Funnel.**
   a. `sudo brew services start tailscale` then `sudo tailscale up` — it prints a link: open it, sign in (create the free Tailscale account), approve the machine.
   b. In the Tailscale admin console (<https://login.tailscale.com/admin>): **DNS** → turn on **MagicDNS** and **HTTPS Certificates**. The console shows the
      machine name: the address will be `https://<machine>.<your-tailnet>.ts.net`.
   c. `tailscale funnel --bg 3000` — if it says Funnel is not allowed it prints a link to enable it for this machine: open it, accept, run the command again.
      It prints the public `https://….ts.net` address.
   d. Tell the app its public address (it only accepts writes coming from it): `./scripts/training/set-url.sh https://<machine>.<tailnet>.ts.net`
   e. Test from a phone on mobile data (not the home Wi-Fi): the login page opens with the red banner.
9. **Nightly dump** (outside the repository, 14 kept): `crontab -e` and add
   `30 2 * * * cd $HOME/belgobeton && ./scripts/training-backup.sh >> $HOME/belgobeton-training-backup.log 2>&1`
   Restore one (stop the app first): `./scripts/training/dc.sh stop app`, then
   `./scripts/training/dc.sh exec -T db pg_restore -U postgres -d belgobeton --clean --if-exists < ~/belgobeton-training-backups/training-<stamp>.dump`, then `./scripts/training/dc.sh up -d app`.

## Day to day
- Stop: `./scripts/training-down.sh` (data kept). Start: `./scripts/training-up.sh`.
- **Stop the Funnel** (the public address closes at once): `tailscale funnel reset`. Do this whenever nobody is training.
- **Reset to the clean seed** (erases everything entered, new passwords): `./scripts/training-reset.sh` (asks you to type RESET), then `./scripts/training/show-accounts.sh`.
  It only ever wipes a database that carries the training marker.
- **New version:** take the new digest from the latest green Actions run, replace the `APP_IMAGE=` line in `.env.training`, run `./scripts/training-up.sh` (it migrates).
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
and gets the certificate; the app stays on 127.0.0.1), point the domain's A and AAAA records at the VPS, and close the Funnel on the iMac. Copy the data over with
a dump of the last night (step 9) if the trainees' work should follow. The production instance is another matter: it uses `docker-compose.prod.yml`, `APP_ENV=production`
and the runbook, and it cannot be started with training mode or on a training database.
