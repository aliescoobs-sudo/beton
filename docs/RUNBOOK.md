# BELGOBETON — Runbook (production)

Written 2026-11-02 for the production build (REQUIREMENTS-V1 §14, CP-PROD-PLAN R9). Provider-neutral: any Linux host that runs Docker, in a Moroccan data centre. The rules of `CLAUDE.md` apply: security and privacy first; no secret in git; real personal data only after the CNDP declaration is filed.

## 0. Before anything
- [ ] The **CNDP declaration** is filed (employees, clients, suppliers, drivers). No real personal data is entered before. Driver geolocation is not in V1.
- [ ] The independent **security review** of Codex has run on the final `main` (portals stay off until it has).
- [ ] The last 2026 **invoice number** is known (REQUIREMENTS-V1 §9) and the accountant has chosen the final-invoice timing.
- [ ] The age **key pair** exists. The private key stays off the server (office machine and a sealed copy). Only the public key (`BACKUP_AGE_RECIPIENT`) goes on the server.

## 1. The host
- A VPS (any provider) with Docker and Docker Compose. Firewall: allow **22 (SSH, key only), 80, 443**; deny everything else. PostgreSQL is **never** published (the compose file puts it on an internal network; a test enforces it).
- SSH: key only (`PasswordAuthentication no`, `PermitRootLogin no`), a non-root deploy user, `unattended-upgrades` (or the distribution equivalent) for security updates, `fail2ban` optional.
- A DNS name for `APP_DOMAIN`; the proxy (Caddy) gets the certificate by itself. Any other reverse proxy works if it appends the client address to `X-Forwarded-For` (`TRUSTED_PROXY_HOPS=1`).
- Time: `chrony`/`systemd-timesyncd` on (audit timestamps and the second factor depend on it).

## 2. Secrets (on the server only, `chmod 600`, never in git)
`.env.prod` (the app): `DATABASE_URL_APP`, `DATABASE_URL_AUTH`, `DATABASE_URL_SYSTEM` (host `db`, internal), `AUTH_SECRET` (≥ 32 random chars), `FIELD_ENCRYPTION_KEYS`, `RECOVERY_CODES_KEYS`, `LOOKUP_HMAC_KEY`, `APP_BASE_URL=https://<APP_DOMAIN>`, `BACKUP_AGE_RECIPIENT`, `FIELD_APP_ENABLED=false` until its acceptance passes (R4). Generate keys with `openssl rand -base64 32`; see `.env.example` for the shape.
`.env.ops.prod` (maintenance only): `POSTGRES_SUPERUSER_PASSWORD`, `DATABASE_URL_MIGRATOR`, `DATABASE_URL_BACKUP`. These two never go into the app container's environment.

> The image build (`next build`) needs about 4 GB of RAM. On 2026-11-02 the build on the Mac's Colima VM (default memory) was killed (exit 137): the Dockerfile itself is untested end to end. Build on the server or a CI runner with ≥ 4 GB, or raise the Colima memory, and run the install steps below as the first real test.

## 3. First install
```
git clone <repo> /srv/belgobeton && cd /srv/belgobeton
docker compose -f docker-compose.prod.yml --env-file .env.ops.prod up -d --wait db
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml run --rm ops corepack pnpm db:bootstrap      # roles and the database
docker compose -f docker-compose.prod.yml run --rm ops corepack pnpm db:migrate        # structure only (no data)
docker compose -f docker-compose.prod.yml run --rm ops corepack pnpm user:create-owner # the owner, with 2FA enrolment
docker compose -f docker-compose.prod.yml up -d app proxy
```
Then: sign in as the owner, enrol the second factor, create the two plants (Tétouan, Chefchaouen) under *Centrales*, the accounts under *Gérer les utilisateurs*, and work through *Liste de sécurité* (`/checklist`): with `REAL_DATA=true` the server **refuses to start** until it is complete.
Check: `docker compose -f docker-compose.prod.yml exec app wget -qO- http://127.0.0.1:3000/api/health/ready` answers `{"status":"ready"}`.

## 4. Loading the data (Excel)
Files in `./imports/` (xlsx or csv). Order matters. Always a **dry run first**; read the report; fix the file; only then `--apply`.
```
docker compose -f docker-compose.prod.yml run --rm ops corepack pnpm import:excel concrete_types imports/types.xlsx
docker compose -f docker-compose.prod.yml run --rm ops corepack pnpm import:excel concrete_types imports/types.xlsx --apply
```
Kinds, in order: `concrete_types`, `clients`, `suppliers`, `trucks`, `selling_prices`, `opening_balances` (`--opening-date YYYY-MM-DD`). Headers accepted in French or English (e.g. *Nom, Type, ICE, Téléphone, Délai de paiement*; trucks: *Code, Immatriculation, Capacité (m³), Type, Centrale*). A dry run writes nothing and lists, per line, what is new, already there, or wrong; an error anywhere blocks the whole file; a re-run skips what exists. Reports are saved in `.logs/`. **Not importable yet:** cheques in transit (entered by the office from the paper), components and recipes (set up with the plants on 3 Nov), history of previous months (later).

## 5. Backups
- **Nightly on the server** (cron `30 2 * * *`): `scripts/ops/backup-nightly.sh` — `pg_dump` as the read-only backup role, sealed with the age public key, the audit anchor beside it, last 14 kept.
- **Nightly pull to the office machine** (cron/launchd `0 4 * * *`): `SERVER=backup@host scripts/ops/backup-pull.sh` — the office machine opens the connection with its own key (a read-only account that can read `backups/` only); the server holds no key to the office machine and no private age key. The script checks the checksum and keeps 30 sets. Check the log of that job each morning.
- **Restore test, monthly and after every migration**, on a machine that has the private key: `BACKUP_AGE_IDENTITY_FILE=… corepack pnpm backup:restore-test <file>` — restores into a scratch database and checks the anchor, the migrations, the row counts and the whole audit chain. A backup nobody restored is not a backup. Last run on the dev database: 2026-11-02, all checks OK.
- Sign the anchor (open question 12) with a key held off the server before go-live, or mirror the last audit hash to an independent store.

## 6. Updating
```
git pull && docker compose -f docker-compose.prod.yml build
./scripts/ops/backup-nightly.sh                                          # a fresh backup first
docker compose -f docker-compose.prod.yml run --rm ops corepack pnpm db:migrate
docker compose -f docker-compose.prod.yml up -d app
```
Migrations are additive (expand/contract). Rollback of the code: `git checkout <previous tag>`, rebuild, `up -d app` (the schema stays compatible: no migration drops anything). Rollback of data: restore the backup (§5) into a scratch database first, decide, then replace.

## 7. Module flags
A module is switched on only after its acceptance tests pass **on the server**. `FIELD_APP_ENABLED` (driver and pump phone app) is an environment flag, off by default. Never on with real data: `ASSISTANT_ENABLED`, `AI_EXTRACTION_ENABLED`, `SIMULATION_ENABLED` (the server refuses to start). The client and supplier portals have no account creation and stay off until the independent review.

## 8. Day to day
- **Monitoring:** poll `/api/health/ready` from the server (not the proxy: it answers 404 outside) every minute from an external monitor over SSH or a cron `curl`; alert on two failures. Watch disk space of the `pgdata` and `backups` volumes, and the backup job logs.
- **Logs:** `docker compose logs --since 1h app`. The app logs no secret, no PIN and no personal field (a test greps for it); still treat logs as sensitive.
- **Drivers:** *Chauffeurs (téléphones)* — create the account, set the PIN (shown nowhere afterwards), release the phone when a driver changes it. Five wrong PINs lock the driver for 15 minutes.
- **Accounts:** disable, never delete. The owner account cannot be disabled by the application. Lost authenticator of the owner: `corepack pnpm user:reset-owner-2fa` on the server (needs the database superuser password; alerts the owner).
- **Key rotation:** `corepack pnpm crypto:rotate` after adding a new version to `FIELD_ENCRYPTION_KEYS` / `AUTH_SECRETS`.

## 9. Incident
1. **Suspected leak or intrusion:** keep the evidence (do not wipe). Disable the account concerned; revoke the sessions; rotate `AUTH_SECRET`. Run `corepack pnpm audit:verify` (chain intact?) and read the audit viewer for the period. If personal data may have left: the CNDP must be told (law 09-08) — decide with the owner the same day.
2. **Server down:** `docker compose ps`, `logs`, disk space, `ready` endpoint. Restart `app` first; the database restarts by itself.
3. **Database damaged:** stop `app`, restore the latest backup into a scratch database (§5), verify, then switch. The audit anchor says whether the restored history is complete.
4. **A phone is lost:** release the device in *Chauffeurs (téléphones)*; the token stops working at once.

## 10. What this runbook does not do
It does not choose the hosting provider (criteria in order: stability, security, cost; Morocco). It does not file the CNDP declaration. It does not replace the independent security review.
