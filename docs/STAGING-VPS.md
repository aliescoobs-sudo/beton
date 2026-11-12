# KAYAS staging on a rented VPS — runbook (T10g)

Written 12 Nov 2026 for the independent review `docs/reviews/CODEX-REVIEW-R19B-DEPLOY.md` (R19B). **Nothing in this file has been run on the VPS.** The configuration was proven on a local rehearsal (`scripts/staging/rehearse.sh`; evidence in `docs/checkpoints/CP-STAGING.md`). Codex's narrow R20 verification of R19 + R19B comes **before** the owner deploys anything.

## 0. What staging is — and what it is not

- A copy of the app with **fictitious "twin" data only**, **training mode ON**, behind **HTTP Basic Auth on the whole site**, on a rented VPS, so that the owner and a few people can look at it from their phones.
- **Real data stays forbidden.** Gates G1–G12 (`docs/REAL-DATA-GATES.md`) stay open. Nothing here approves any real file, real name or real amount.
- **Data policy: staging data is disposable. It is RESET (`scripts/staging/reset.sh`), never restored from a backup, and its volumes are never reused for real data.** There is no backup job on staging. Losing the VPS loses nothing that matters.
- The app's own login (password, and TOTP where it is enrolled) stays fully on top of Basic Auth. Basic Auth is an outer gate, not a replacement.
- Server-side **history import is switched OFF** (`STAGING_PROFILE=true`, refused by the CLI and by the service) and **no folder of the host is mounted** into any container. The only data is the seed the app makes itself.
- Provider AI, extraction, maps, web push and VAPID are off **and absent** (no key exists in any file).

Production-only items that are **not** done here and stay gates before any real data: **R19B-06** (backup pruning/verification vs host ownership, run in the uid-10001 backup container, real Linux users) and **R19B-07** (replacement-host recovery: database + filestore + versioned application keys from an off-host signed set), and the complete effective-value twin validation of **R19B-03**. See `docs/REAL-DATA-GATES.md`.

## 1. Facts assumed about the VPS (prepared by the owner — verify, do not redo)

Ubuntu 24.04 LTS, 2 vCPU, 4 GB RAM + 2 GB swap, 38 GB disk. Host name `kayas.aliobsil.com`, one **A** record (IPv4 only, **no AAAA**). SSH key-only, root login off, `MaxAuthTries 3`; UFW deny-in with 22/80/443 allowed (v4 and v6); fail2ban (sshd jail); unattended-upgrades; time sync ok. Docker 29.x and Compose v5.x from the official repository; `/etc/docker/daemon.json` has `json-file` 10 MB × 3 and `live-restore`. The current login is `ubuntu` (sudo). **There is no `deploy` account yet: step 4 creates it.**

**The Docker group is root-equivalent.** Whoever can run `docker` on this host can read every container's environment (`docker inspect`), mount the host, and become root. The `deploy` account is therefore as powerful as `ubuntu`; it is a separate identity for audit and hygiene, not a privilege boundary. Staging accepts that (fictitious data); production does not (gate G11).

**Env secrets are visible to Docker and to root.** The app's secrets are environment variables, not Docker secrets. Accepted for staging; a production gate.

## 2. Order of work (the 13 prerequisites of R19B, adapted)

| R19B prerequisite | Where here |
| --- | --- |
| 1 approve one release | §3 |
| 2 fresh staging storage | §10 (volume check) |
| 3 provision access safely | §5 |
| 4 network policy | §6 |
| 5 host budgets | §6, §16 |
| 6 DNS / TLS | §4 (DNS **before** the proxy), §12 |
| 7 host artifacts + registry access | §7, §8 |
| 8 private configuration | §9 |
| 9 the Basic gate | §11 |
| 10 backup / recovery | **none for staging: reset, not restore** (§0); production gate |
| 11 generated twin only | §12 (the seed), §13 (TOTP) |
| 12 ordered first start | §12 |
| 13 authorise exposure only after checks | §14, §15, §17 |

## 3. Approve one release (on the Mac, before touching the VPS)

1. Pick the commit. On GitHub, open the "Build and publish image" run **for that exact commit**: it must be green, including the **Integration tests** job (the image job `needs` it, so a digest exists only if integration passed). Also confirm the full e2e on that commit (docs/RUNBOOK.md §6).
2. In the run summary copy the four values: **commit**, **image digest** (`ghcr.io/aliescoobs-sudo/kayas@sha256:…`), **platform** (`linux/amd64`), **run id**. Write them in your password manager note for this release. A tag is never accepted.
3. The reviewed artifact is the image built from that commit, nothing else. Do not build anything on the VPS.

## 4. DNS comes first

At the DNS provider: one **A** record `kayas.aliobsil.com` → the VPS IPv4. **No AAAA** (IPv6 does not work for this site; a stray AAAA would make Caddy's certificate check and browsers use it). Verify from your Mac, before anything else:

```
dig +short A    kayas.aliobsil.com        # the VPS IPv4
dig +short AAAA kayas.aliobsil.com        # must print nothing
```

Caddy asks Let's Encrypt for the certificate on first start; that needs this record, ports 80/443 reachable from the internet, outbound DNS/HTTPS from the VPS, and a persistent Caddy volume (the compose file has one). **Never** fix a certificate error by weakening TLS or cookies.

## 5. Provision access: the `deploy` account (as `ubuntu`)

Keep your current `ubuntu` SSH session open until the second session below works.

```
# on the Mac: a dedicated key, with a passphrase
ssh-keygen -t ed25519 -f ~/.ssh/kayas-staging-deploy -C "kayas staging deploy"
cat ~/.ssh/kayas-staging-deploy.pub              # copy this ONE public line

# on the VPS, as ubuntu
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG docker deploy                    # root-equivalent: see §1
sudo install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
sudo -u deploy sh -c 'umask 077; cat > ~/.ssh/authorized_keys'      # paste the public line, Ctrl-D
sudo sshd -t                                      # no output = the config is valid
```

**Second-session test (a NEW terminal, key only):**

```
ssh -i ~/.ssh/kayas-staging-deploy deploy@kayas.aliobsil.com 'id; docker ps'
```

Only when that works, treat the access as provisioned. `deploy` has no sudo. The checks that need root (`verify-host.sh`) run as `ubuntu`. Confirm the SSH daemon settings (`sudo sshd -T | grep -Ei 'passwordauthentication|kbdinteractive|permitrootlogin|pubkeyauthentication|maxauthtries'`): password off, keyboard-interactive off, root login off, public key on, `maxauthtries 3`. Keep the provider's web console (rescue access) reachable in case you lock yourself out.

## 6. Host checks (as `ubuntu`)

```
sudo ufw status verbose                  # deny incoming; 22, 80, 443 allowed, v4 and v6
sudo systemctl is-active fail2ban unattended-upgrades
timedatectl show -p NTPSynchronized      # yes
free -h; swapon --show; df -h /          # 4 GB + 2 GB swap, 38 GB disk
docker info --format '{{.LoggingDriver}} {{.LiveRestoreEnabled}}'      # json-file true
sudo cat /etc/docker/daemon.json         # json-file, max-size 10m, max-file 3, live-restore
```

**Docker bypasses UFW** for published ports (it writes its own iptables rules). This stack publishes only the proxy's 80 and 443, and `verify-host.sh` (step 14) reads every published binding of every container; an external **all-port scan** (step 14) is the independent proof. A provider-level firewall in front of the VPS (22, 80, 443 only) is a second layer if the provider offers one.

Resource budget (the compose limits add up to 2.75 GB for db + app + proxy, plus up to 1 GB for a maintenance job, on a 4 GB host with 2 GB swap): db 1 GB, app 1.5 GB (`--max-old-space-size=1024`), proxy 256 MB. Watch `docker stats --no-stream` and `dmesg | grep -i oom` during the first sessions. Disk: Docker logs are capped (10 MB × 3 per service); the images are about 1.7 GB.

## 7. Get the pinned release onto the VPS (as `deploy`)

The repository is private. Use a **read-only deploy key** for it, created on the VPS:

```
ssh-keygen -t ed25519 -f ~/.ssh/kayas-repo-readonly -C "kayas staging read-only"
cat ~/.ssh/kayas-repo-readonly.pub     # the owner adds it as a READ-ONLY deploy key of the GitHub repository
printf 'Host github.com\n  IdentityFile ~/.ssh/kayas-repo-readonly\n  IdentitiesOnly yes\n' >> ~/.ssh/config
sudo mkdir -p /srv/kayas && sudo chown deploy:deploy /srv/kayas     # run the sudo lines as ubuntu
git clone git@github.com:aliescoobs-sudo/beton.git /srv/kayas && cd /srv/kayas
git checkout --detach <approved commit>       # never a branch tip, never `git pull`
test "$(git rev-parse HEAD)" = "<approved commit>" && echo "pinned"
```

Every wrapper re-checks this on every run: the host files must be at the approved commit and no tracked file may be edited.

## 8. Registry access and the image

The package is private. Create a **classic personal access token with the single scope `read:packages`**, **expiry 30 days**, in the GitHub account that owns the package (fine-grained tokens cannot read user-owned container packages). Revoke it when staging is retired. Handle it like this:

```
read -rs -p "GHCR token: " T; echo                       # hidden; nothing in the shell history
printf %s "$T" | docker login ghcr.io -u aliescoobs-sudo --password-stdin; unset T
docker pull ghcr.io/aliescoobs-sudo/kayas@sha256:<digest>
docker logout ghcr.io                                    # the token does not stay at rest
ls -l ~/.docker/config.json; grep -c auth ~/.docker/config.json   # after logout: no stored auth
```

Linux has no OS keychain for Docker by default: while logged in, the token sits in `~/.docker/config.json` (mode 0600, under `/home/deploy`, mode 0700). Logging out right after the pull keeps it off the disk; log in again for an upgrade. Never type the token as an argument.

Record the approval and check the image:

```
./scripts/ops/approve-release.sh <commit> ghcr.io/aliescoobs-sudo/kayas@sha256:<digest> linux/amd64 <run id>
docker image inspect --format '{{.Os}}/{{.Architecture}} {{.Id}}' ghcr.io/aliescoobs-sudo/kayas@sha256:<digest>     # linux/amd64
# the image holds no env file, no test source, no key, no import folder:
docker run --rm --entrypoint sh ghcr.io/aliescoobs-sudo/kayas@sha256:<digest> -c 'ls -A /app | grep -E "^\.env|^e2e$|^tests$|^imports$|^keys$|^backups$" ; echo "(nothing above = good)"'
```

## 9. Private configuration (as `deploy`, in `/srv/kayas`)

```
APP_DOMAIN=kayas.aliobsil.com ./scripts/staging/init-env.sh
ls -l .env.staging .env.staging.ops      # -rw------- both
```

`init-env.sh` makes both files exclusively and private from the first byte (it sets `umask 077` itself), draws fresh random secrets (URL-safe database passwords), sets the exact origin `https://kayas.aliobsil.com`, and prints no secret. It contains **no** image, **no** provider key, **no** VAPID key and **no** Basic hash. Do not edit these files by hand to "fix" a warning: if validation refuses a combination, the compose file is what changes, never the guard. There is no key escrow for staging: lost keys mean reset.

## 10. A genuinely new storage (check, do not assume)

```
docker volume ls --filter label=com.docker.compose.project=kayas-staging     # must print nothing before the first start
```

The compose project `kayas-staging` has its own database, filestore, accounts and Caddy volumes, shared with nothing (not production, not the local training stack). The database container writes a one-time **birth marker** the first time it initialises an empty volume; the seed refuses a database without it. The marker is a consumable marker, not proof of provenance: "this volume is new" is **your** check, the command above.

## 11. The Basic Auth gate (as `deploy`, in a real terminal)

```
ssh -t -i ~/.ssh/kayas-staging-deploy deploy@kayas.aliobsil.com
cd /srv/kayas && ./scripts/staging/make-basic.sh
```

It asks for a user name and a password (at least 16 characters) at **hidden** prompts, computes the bcrypt hash with Caddy's own tool in a throwaway container (the password reaches it on stdin, never as an argument), and writes `staging/basic-auth.caddy` (mode 0600). Use a strong password **different from every app password**; store it in the owner's password manager. The hash is a **file**, not an environment variable, because a bcrypt hash contains `$` and Compose would mangle it. The gate covers **every** path: pages, RSC, static files, the app's login, the phone endpoints, the APIs and every error page, with no exemption. Only Caddy's own certificate challenge is answered before the gate, and it never reaches the app.

## 12. First start — the one safe order

```
cd /srv/kayas && ./scripts/staging/up.sh
```

`up.sh` runs: pull → credentials folder → **database only** → role bootstrap → migrations → **fresh training seed** → app + readiness + a pause that lets the app pass its reserved-role boot probe → **proxy last** (only if the Basic hash file exists). Each privileged step is recorded in `.staging-evidence/ops-executions.jsonl` (approved digest next to the actual image id). When it finishes the proxy has asked for the certificate (DNS and ports must be right: §4, §6).

The seed creates 11 fictitious accounts; their one-time credentials are in a Docker volume only. Read **one account at a time**, in person, never the whole list, never pasted anywhere:

```
./scripts/staging/show-accounts.sh                      # the list of names, no secret
./scripts/staging/show-accounts.sh proprietaire         # one block
```

Then clear the terminal. Expected: the red banner "Version de formation — données fictives" on every page; reserved `@formation.beton.invalid` accounts only; no outbound call.

## 13. Owner and admin TOTP (through the protected HTTPS site)

Do this **before** giving the address to anyone. In a browser: `https://kayas.aliobsil.com` → the browser asks for the Basic user/password → the app's own login (owner, then admin, with the password from `show-accounts.sh`) → enrol the authenticator (QR code or key on your own phone) and store the recovery codes. Finance needs a real second factor even in training. Repeat for the admin account.

## 14. External checks — before the address is shared

From **another machine** (your Mac, on a different network if possible). `curl` asks for the password when you give `-u user` without it, so it never enters the shell history.

```
H=kayas.aliobsil.com
curl -sI https://$H/ | head -n1                          # HTTP/2 401   (no credentials)
curl -sI -u 'wronguser:wrongpass' https://$H/fr/login | head -n1       # 401
curl -s -o /dev/null -w '%{http_code}\n' -u 'user' https://$H/fr/login   # prompts; 200 and the app's login page
curl -s -o /dev/null -w '%{http_code}\n' -u 'user' https://$H/fr/admin/field   # 307: valid Basic still needs an app session
curl -sI http://$H/ | head -n3                           # 308 to https://$H/
curl -sk -o /dev/null -w '%{http_code}\n' https://<IPv4 of the VPS>/           # not served (TLS error, no site for a bare address)
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: other.example' http://<IPv4>/ # 404
openssl s_client -connect $H:443 -servername $H </dev/null 2>/dev/null | openssl x509 -noout -issuer -dates   # a Let's Encrypt certificate, valid
nmap -Pn -p- <IPv4 of the VPS>                           # ALL ports: only 22, 80, 443 open
```

On the VPS, as `ubuntu`: `sudo /srv/kayas/scripts/ops/verify-host.sh --staging` (reads `sshd -T`, judges every published binding of every container one by one, reads the host listeners; any docker error is a failure, not an empty list). There is no AAAA record, so an IPv6 scan is not applicable; if you ever add one, scan `nmap -6` as well.

Forged `X-Forwarded-For`, `Host` and `Authorization` headers never reach the app (proved against the real `Caddyfile.staging` in the local rehearsal; the 401 gate and the app's one-hop trust are the same configuration).

## 15. Phones and the field PWA behind Basic Auth

- A phone's browser shows its own username/password prompt the first time, then remembers the credentials for the session; closing the browser asks again. Give the Basic credentials and the app credentials as two separate things.
- The field PWA (driver page, service worker, manifest) works after Basic is accepted: the rehearsal's browser test registers the service worker through the gate, and without credentials the script is refused (401). If a phone says "login failed" after several tries, it is the **app's** per-IP lockout, not Basic Auth: wait ~15 minutes.
- Add-to-home-screen on a phone keeps working; if the credentials expire the PWA shows the browser prompt again.
- Do not ask for exemptions of "just the manifest" or "just the phone login": there are none.

## 16. Reboot rehearsal and day-to-day

```
sudo reboot            # as ubuntu
# after the VPS is back (2-3 minutes):
ssh deploy@kayas.aliobsil.com 'cd /srv/kayas && ./scripts/staging/dc.sh ps'     # db, app, proxy: running, healthy
# then repeat the 401 / 200 checks of §14 from outside. No manual step may be needed.
```

All services restart by themselves (`restart: unless-stopped`; Docker starts at boot; `live-restore` keeps containers across a daemon restart). Logs: `./scripts/staging/dc.sh logs --since 1h app` (sensitive: they can contain request metadata; the Caddy log carries no `Authorization`). Disk and memory: `df -h /`, `docker system df`, `docker stats --no-stream`. The proxy has a health check; a hung app is seen by `ps` (healthy → unhealthy) but not restarted by Docker: restart it with `./scripts/staging/dc.sh up -d --force-recreate app`.

**Upgrading or resetting** is the same act (staging is disposable): `./scripts/staging/reset.sh` (typed confirmation `RESET-STAGING`; deletes the database, documents and seed credentials, keeps the certificates), then `./scripts/ops/approve-release.sh … --replace`, `git checkout --detach <new commit>`, `./scripts/staging/up.sh`. **Never restore a database into staging**, and never point a real-data install at a staging volume.

## 17. What was hardened, and what could not be

Applied in `docker-compose.staging.yml` and proven on a real local run (CP-STAGING): `no-new-privileges` on every service; `cap_drop: ALL` with only what is needed added back (PostgreSQL: CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID; Caddy: NET_BIND_SERVICE; the credentials-folder job: CHOWN and FOWNER, on that one run only); read-only root file systems with small tmpfs mounts (the app needs `/tmp`, `/app/.next/cache` and one `exec` tmpfs for the SWC native addon that loads `next.config.ts`); memory, process and CPU limits; bounded `json-file` logs; the database and the app publish no port; the proxy is the only published service; Caddy's admin API is off, the request body is capped (12 MB), header/body/idle timeouts are set; no access log. The same hardening is in `docker-compose.prod.yml`, asserted by `docker compose config` and `validate-compose.py`, but **not** run with `REAL_DATA`.

**Not applied:** read-only root for the production `ops`/`bootstrap`/`backup` containers (their real import and backup paths were not exercised read-only); user namespaces / rootless Docker; seccomp or AppArmor profiles beyond Docker's defaults; Docker secrets instead of env variables; image signature verification (the digest and the CI run are the only provenance); a separate Docker network policy beyond `internal`/`edge`; log shipping and alerting (staging has none).

## 18. The wrappers refuse, on purpose

`scripts/staging/dc.sh` and `ops.sh` refuse: an `APP_IMAGE` or `COMPOSE_*` in the shell, an `APP_IMAGE` in any env file, a missing/malformed `release/APPROVED`, host files that are not at the approved commit or are edited, options of `run`/`exec` that add a mount, a variable or a privilege, `down -v`, and any effective configuration that is not exactly the expected one. A refusal happens **before** a container exists. If a wrapper refuses something you expected to work, the answer is to fix the input, not to bypass the wrapper.
