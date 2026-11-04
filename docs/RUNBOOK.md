# BELGOBETON — Runbook (production)

Written 2026-11-02, rewritten 2026-11-03 (C2) after the independent review `docs/reviews/CODEX-REVIEW-R9.md`. For the production build (REQUIREMENTS-V1 §14, CP-PROD-PLAN R9). Hosting: **Infomaniak, Switzerland** (a Linux VM that runs Docker; Switzerland is on the CNDP list of countries with adequate protection). The rules of `CLAUDE.md` apply: security and privacy first; no secret in git; real personal data only after the CNDP declarations are filed.

> Every `docker compose` command below is written `./scripts/ops/dc.sh …`. The wrapper passes `-f docker-compose.prod.yml --env-file .env.ops.prod`; a bare `docker compose` in a clean shell or a cron job cannot read the compose file. Maintenance scripts run with plain node through `./scripts/ops/ops.sh <script> [args]` (no pnpm, no download, the container has no network).

## 0. Before anything
- [ ] The **CNDP declaration** is filed (employees, clients, suppliers, drivers) **including the declaration of the transfer of data to Switzerland (Infomaniak)** and the hosting and processing terms with the provider. No real personal data is entered before. Driver geolocation is not in V1.
- [ ] The independent **security review** of Codex has run on the final `main` (portals stay off until it has).
- [ ] The last 2026 **invoice number** is known (REQUIREMENTS-V1 §9) and the accountant has chosen the final-invoice timing.
- [ ] The **keys** exist and are escrowed (§2): the age key pair, the backup signing key pair, and the application keys (`FIELD_ENCRYPTION_KEYS`, `RECOVERY_CODES_KEYS`, `AUTH_SECRETS`/`AUTH_SECRET`, `LOOKUP_HMAC_KEY`) with every retired version, sealed copy off the server. **The age key alone does not open the stored documents or the encrypted fields.**

## 1. The host
- A VM at Infomaniak with Docker and Docker Compose, **4 GB RAM or more** to run (the image is built elsewhere, see §6). Firewall (Infomaniak security group **and** the host, IPv4 **and** IPv6): allow **22 (only from the administration addresses), 80, 443**; deny everything else. PostgreSQL is **never** published (the compose file puts it on an internal network; a test enforces it). UFW alone does not close a port that Docker publishes.
- SSH: key only (`PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PermitRootLogin no`), a non-root deploy user, `unattended-upgrades`, `fail2ban` optional. Time: `chrony`/`systemd-timesyncd` on (audit timestamps and the second factor depend on it).
- A DNS name for `APP_DOMAIN` (A and AAAA records to the VM) **before** the first start: Caddy asks for the certificate by itself, redirects HTTP to HTTPS and renews it. It refuses to start without `APP_DOMAIN`.
- Directories and owners, once, as root: `sudo ./scripts/ops/init-host.sh <backup-pull-user> <deploy-user>` (containers run as uid 10001; `backups/` is `2750` owned by 10001, group `belgobeton-backup`, so the pull account reads and never writes; `keys/` and `reports/` are `2750` owned by the deploy account, group 10001, so the deploy account uploads the public signing key and the restore reports and the container reads them). `sudo ./scripts/ops/verify-host.sh` checks these owners and modes.
- **Verify, do not assume:** `sudo ./scripts/ops/verify-host.sh` (reads `sshd -T`, lists what Docker publishes), then from another machine `nmap -Pn -p 22,80,443,3000,5432 <ipv4>` and `nmap -6 …`: only 22 (from your addresses), 80 and 443 may answer.

## 2. Secrets (on the server only, `chmod 600`, never in git, one file per purpose)
- `.env.prod` (**the app**): `DATABASE_URL_APP`, `DATABASE_URL_AUTH`, `DATABASE_URL_SYSTEM` (host `db`, internal), `AUTH_SECRET` (≥ 32 random chars), `FIELD_ENCRYPTION_KEYS`, `RECOVERY_CODES_KEYS`, `LOOKUP_HMAC_KEY`, `APP_BASE_URL=https://<APP_DOMAIN>`, `BACKUP_AGE_RECIPIENT`, `FIELD_APP_ENABLED=false` until its acceptance passes. **No migrator, backup or superuser login in this file** (the security checklist checks it; the app does not even read `DATABASE_URL_MIGRATOR`).
- `.env.ops.prod` (**maintenance and compose**): `POSTGRES_SUPERUSER_PASSWORD`, `DATABASE_URL_MIGRATOR`, `APP_DOMAIN`, `APP_IMAGE=ghcr.io/<owner>/belgobeton@sha256:<digest>`, `FIRST_BOOT` (only during §3).
- `.env.backup.prod` (**the backup job only**): `DATABASE_URL_BACKUP`, `BACKUP_AGE_RECIPIENT`. Nothing else of the application's secrets.
- `.env.bootstrap.prod` (**temporary, first install only**): the one line `DATABASE_URL_BACKUP=…` (the same value as in `.env.backup.prod`), because creating the roles sets the backup login's password. `./scripts/ops/bootstrap.sh` refuses the file if it holds anything else and **deletes it after a successful run**. The app and the maintenance container never read it.
- `keys/backup-signing.pub` (public key of the office signing key; not a secret).
- Generate keys with `openssl rand -base64 32`; see `.env.example` for the shape. **Key escrow:** write the application keys and **all their retired versions** to a sealed medium kept off the server (office safe, and a second place). Rotating keys (§8) never deletes a retired key that an existing backup needs.
- Key pairs, on the **office machine**: `age-keygen -o ~/belgobeton-keys/age.key` (the public line goes to `BACKUP_AGE_RECIPIENT`) and `node --import ./scripts/register-ts-paths.mjs scripts/backup-verify.ts keygen ~/belgobeton-keys` (signing pair; the private key never leaves the office machine).

## 3. First install (and the protected first start)
The image is built by GitHub Actions and pulled **by digest** (§6). On the server: `docker login ghcr.io` once with a read-only token (`read:packages`) of the private registry.
```
git clone <repo> /srv/belgobeton && cd /srv/belgobeton
sudo ./scripts/ops/init-host.sh <backup-pull-user> <deploy-user>
# .env.ops.prod: APP_IMAGE=ghcr.io/<owner>/belgobeton@sha256:<digest>  APP_DOMAIN=…  FIRST_BOOT=true
docker pull "$(grep ^APP_IMAGE= .env.ops.prod | cut -d= -f2-)"
./scripts/ops/dc.sh up -d --wait db
printf 'DATABASE_URL_BACKUP=<the same value as in .env.backup.prod>\n' > .env.bootstrap.prod
./scripts/ops/bootstrap.sh                 # roles and the database; deletes .env.bootstrap.prod when it succeeds
./scripts/ops/ops.sh db-migrate            # structure only (no data)
./scripts/ops/ops.sh create-owner          # the owner, with 2FA enrolment
./scripts/ops/dc.sh up -d app proxy
```
**Why `FIRST_BOOT=true`:** with `REAL_DATA=true` the server refuses to start until the security checklist is complete, and the checklist is completed inside the app (enrol the second factor, mark the items). `FIRST_BOOT=true` breaks that loop without weakening the protection: the server starts in a **restricted mode** that serves only sign-in, enrolment, the checklist, user accounts, plants and parameters (every other page and endpoint answers 503). It **refuses to start** (a) once any client, supplier, order, delivery, invoice or payment exists, and (b) once the checklist is complete, so it cannot stay on. Procedure: the owner signs in and enrols, creates the plants and accounts, works through *Liste de sécurité* (`/checklist`); the manual items are marked with evidence; the restore test evidence arrives through §5; when the sign-off is done **remove `FIRST_BOOT` from `.env.ops.prod` and run `./scripts/ops/dc.sh up -d app`**. Check: `./scripts/ops/dc.sh exec -T app wget -qO- http://127.0.0.1:3000/api/health/ready` answers `{"status":"ready"}` (database reachable **and** every migration of this build applied).

## 4. Loading the data (Excel)
Files in `./imports/` (never in git, never in the image). Order matters. Always a **dry run first**; read the report; fix the file; only then `--apply`.
```
./scripts/ops/ops.sh import-excel concrete_types imports/types.xlsx
./scripts/ops/ops.sh import-excel concrete_types imports/types.xlsx --apply
```
Kinds, in order: `concrete_types`, `components`, `recipes`, `clients`, `suppliers`, `trucks`, `selling_prices`, `opening_balances` (`--opening-date YYYY-MM-DD`), `cheques_in_transit`. Columns of the three added in C3: **components** *Nom, Nom AR (optional: the French name is used), Unité (g, mL or L), Unité d'achat and Contenu (both or none: the purchase unit and how many base units it holds, e.g. Sac 50 kg = 50000 g)*; **recipes** *Type, Composant (code CMP-nn or French name), Quantité par m³, Unité (kg, g, t, L, mL; default kg for a gram component), À partir du*, one row per line, rows with the same type and date are one version, the date must follow the latest version of the type; **cheques_in_transit** *Client (code or exact name), Type (chèque or LCN), Numéro, Banque, Montant, Date (written on the cheque)*, each becomes an instrument received today, not deposited, not allocated. Headers accepted in French or English. A dry run writes nothing and lists, per line, what is new, already there, or wrong; an error anywhere blocks the whole file; a re-run skips what exists. Reports are saved in `.logs/`.

## 5. Backups
**One backup is one set**: the database and the stored documents (BL scans, supplier invoice photos), each sealed with the age public key, and a manifest written last with their sha256, the file count and the audit anchor. A set without its manifest is incomplete and is never taken.
- **Nightly on the server** (cron `30 2 * * *`, `MAILTO` or `scripts/ops/alert.env` set): `/srv/belgobeton/scripts/ops/backup-nightly.sh`. It runs the `backup` container (its own login, documents read-only), checks the set it just wrote, keeps the last 14 and **alerts on any failure**.
- **Nightly pull to the office machine** (cron/launchd `0 4 * * *`): `SERVER=backup@host SIGNING_KEY_FILE=~/belgobeton-keys/backup-signing.key scripts/ops/backup-pull.sh`. The office machine opens the connection with its own key (an account in group `belgobeton-backup`: read-only). The pull is **staged and verified** before it reaches the store: complete (manifest, both archives), sizes and sha256 equal to the manifest, newest set younger than 30 h, unchanged since the office last signed it; each new set gets a **receipt signed with the office key** (the server has no such key). Any problem — stale, incomplete, damaged, rewritten, audit log shorter than before — **sends an alert and exits non-zero**. A damaged local copy is replaced from a good one.
- **Restore test, monthly and after every migration**, on the office machine that has the keys: `BACKUP_AGE_IDENTITY_FILE=~/belgobeton-keys/age.key BACKUP_SIGNING_PUBLIC_KEY_FILE=~/belgobeton-keys/backup-signing.pub BACKUP_SIGNING_KEY_FILE=~/belgobeton-keys/backup-signing.key FIELD_ENCRYPTION_KEYS='<from the escrow>' corepack pnpm backup:restore-test`. It checks the office signature (an unsigned or re-signed-by-someone-else set fails), both archives, restores the database and the documents into scratch space, **opens every stored document with the escrowed keys**, then the migrations, row counts and the whole audit chain. A backup nobody restored is not a backup.
- **Evidence for the checklist** (the office machine has no route to the production database): `scp` `<stamp>.restore-report.json` and `.sig` to `/srv/belgobeton/reports/` (deploy account), `chmod 640 reports/*` (the container reads them through group 10001; the script says so if it cannot) and run `./scripts/ops/ops.sh checklist-record-restore /app/reports/<stamp>.restore-report.json` (the signature is checked with the public key; the report must be under 36 h old). The rule is **a restore test younger than 35 days** (monthly rhythm plus grace); a quiet month never stops a running server, "never restored" does.
- The signature protects against a set rewritten on the server **after** the office pulled it. A server already compromised **before** the pull can still hand over a consistent forged set; the audit anchor and the continuity check (the audit log may not shrink between sets) narrow that, and the first line of defence remains the host.

## 6. Updating (by digest)
CI builds on GitHub (`.github/workflows/build-image.yml`): lint, types, unit tests, then the image for `linux/amd64`, pushed to the private registry `ghcr.io/<owner>/belgobeton`; the job summary prints the **digest**. No Docker build on the server (a 2 GB VM was killed by `next build`).
```
git pull        # scripts and compose file only
./scripts/ops/deploy.sh ghcr.io/<owner>/belgobeton@sha256:<digest>
```
`deploy.sh` pulls the digest, takes a fresh backup, writes `APP_IMAGE`, migrates with the new image, starts it, waits for readiness and **returns to the previous digest on any failure after the switch** (migration, start or readiness); a failure before the switch (pull, backup) leaves the running image alone. It can be started from any directory. Migrations are additive (expand/contract), so the previous image runs on the migrated schema. Rollback of data is a restore (§5) into a scratch database first, then a decision. Base images (Node, Caddy, Postgres) are rebuilt and redeployed on a schedule (at least monthly) so security fixes arrive: `unattended-upgrades` updates the host, not the images.

## 7. Module flags
A module is switched on only after its acceptance tests pass **on the server**. Environment flags (`FIELD_APP_ENABLED`, `NOTIFICATIONS_ENABLED`, `CANCELLATIONS_ENABLED`, `DOCUMENTS_V1_ENABLED`, `DARIJA_ENABLED`, `ASSISTANT_DET_ENABLED`, `TRANSFERS_ENABLED`, `FINANCE_ENABLED`) are off by default. Finance has a second switch inside the database (owner or app_admin, fresh second factor); both must be on. Never on with real data: `ASSISTANT_ENABLED`, `AI_EXTRACTION_ENABLED`, `SIMULATION_ENABLED` (the server refuses to start). The client and supplier portals have no account creation and stay off until the independent review.

## 8. Day to day
- **Monitoring:** an external monitor over HTTPS on the public name (the proxy answers 404 for `/api/health/*` on purpose, so use a page that needs no sign-in, e.g. the login page) **and** an internal readiness poll from the server every minute (`./scripts/ops/dc.sh exec -T app wget -qO- http://127.0.0.1:3000/api/health/ready`), alert on two failures. Watch disk space of `pgdata`, `filestore` and `backups`, memory/OOM kills (`dmesg`, `docker events`), and the backup job logs; rotate Docker logs (`max-size`/`max-file` in `/etc/docker/daemon.json`).
- **Logs:** `./scripts/ops/dc.sh logs --since 1h app`. The app logs no secret, no PIN and no personal field (a test greps for it); still treat logs as sensitive.
- **Drivers:** *Chauffeurs (téléphones)* — create the account, set the PIN (shown nowhere afterwards), release the phone when a driver changes it. Five wrong PINs lock the driver for 15 minutes.
- **Accounts:** disable, never delete. The owner account cannot be disabled by the application. Lost authenticator of the owner: `./scripts/ops/ops.sh reset-owner-2fa` (needs the database superuser password; alerts the owner).
- **Key rotation:** add the new version first in `FIELD_ENCRYPTION_KEYS` / `AUTH_SECRETS`, keep the old ones after it, restart, then `./scripts/ops/ops.sh crypto-rotate` (it re-encrypts the database columns **and every stored document**; it fails if `FILE_STORE_DIR` is wrong, prints the number of documents it found, and `--check` must report zero). **Do not delete a retired key**: every backup made before the rotation still needs it. Keep the retired versions in the escrow as long as the oldest backup you keep.

## 9. Incident
1. **Suspected leak or intrusion:** keep the evidence (do not wipe). Disable the account concerned; revoke the sessions; rotate `AUTH_SECRET`. Run `./scripts/ops/ops.sh audit-verify` (chain intact?) and read the audit viewer for the period. If personal data may have left: the CNDP must be told (law 09-08) — decide with the owner the same day.
2. **Server down:** `./scripts/ops/dc.sh ps`, `logs`, disk space, the `ready` endpoint. Restart `app` first; the database restarts by itself.
3. **Database damaged:** stop `app`, restore the latest set into a scratch database (§5), verify, then switch. The audit anchor says whether the restored history is complete; the documents come back from the same set.
4. **A phone is lost:** release the device in *Chauffeurs (téléphones)*; the token stops working at once.
5. **Whole server lost:** new VM (§1, §3 without `FIRST_BOOT`), restore the latest set from the office store with the escrowed keys (database **and** documents), `deploy.sh` the last good digest. Rehearse this once before go-live.

## 10. What this runbook does not do
It does not file the CNDP declarations. It does not replace the independent security review. It does not prove the live firewall: §1 says how to check it.
