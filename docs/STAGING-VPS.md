# KAYAS staging on a rented VPS — runbook (T10g)

Written 12 Nov 2026 for the independent review `docs/reviews/CODEX-REVIEW-R19B-DEPLOY.md` (R19B). **Nothing in this file has been run on the VPS.** The configuration was proven on a local rehearsal (`scripts/staging/rehearse.sh`; evidence in `docs/checkpoints/CP-STAGING.md`). Codex's narrow R20 verification of R19 + R19B comes **before** the owner deploys anything.

## 0. What staging is — and what it is not

*Tip: on the VPS, read one section at a time with `sed -n '/^## 11/,/^## 12/p' docs/STAGING-VPS.md` (change the two numbers).*

- A copy of the app with **fictitious "twin" data only**, **training mode ON**, behind **HTTP Basic Auth on the whole site**, on a rented VPS, so that the owner and a few people can look at it from their phones.
- **Real data stays forbidden.** Gates G1–G12 (`docs/REAL-DATA-GATES.md`) stay open. Nothing here approves any real file, real name or real amount.
- **Data policy: staging data is disposable. It is RESET (`scripts/staging/reset.sh`), never restored from a backup, and its volumes are never reused for real data.** There is no backup job on staging. Losing the VPS loses nothing that matters.
- The app's own login (password, and TOTP where it is enrolled) stays fully on top of Basic Auth. Basic Auth is an outer gate, not a replacement.
- Server-side **history import is switched OFF** (`STAGING_PROFILE=true`, refused by the CLI and by the service) and **no folder of the host is mounted** into any container. The only data is the seed the app makes itself.
- Provider AI, extraction, maps, web push and VAPID are off **and absent** (no key exists in any file).

Production-only items that are **not** done here and stay gates before any real data: **R19B-06** (backup pruning/verification vs host ownership, run in the uid-10001 backup container, real Linux users) and **R19B-07** (replacement-host recovery: database + filestore + versioned application keys from an off-host signed set), and the complete effective-value twin validation of **R19B-03**. See `docs/REAL-DATA-GATES.md`.

## 1. Facts assumed about the VPS (prepared by the owner — verify, do not redo)

Ubuntu 24.04 LTS, 2 vCPU, 4 GB RAM + 2 GB swap, 38 GB disk. Host name `kayas.aliobsil.com`, one **A** record (IPv4 only, **no AAAA**). SSH key-only, root login off, `MaxAuthTries 3`; UFW deny-in with 22/80/443 allowed (v4 and v6); fail2ban (sshd jail); unattended-upgrades; time sync ok. Docker 29.x and Compose v5.x from the official repository; `/etc/docker/daemon.json` has `json-file` 10 MB × 3 and `live-restore`. The current login is `ubuntu` (sudo). **There is no `deploy` account yet: §5 creates it.**

**SSH is currently open to the whole internet on port 22** (key-only, `MaxAuthTries 3`, fail2ban). That is accepted for this fictitious-data staging. Restricting 22 to the administrator's own address (UFW `allow from <admin IP> to any port 22`, or the provider firewall) is an optional later step; do it only with the provider's web console available, so a changed home address cannot lock you out.

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

At the DNS provider: one **A** record `kayas.aliobsil.com` → the VPS IPv4. **No AAAA** (IPv6 does not work for this site; a stray AAAA would make Caddy's certificate check and browsers use it). The DNS check below shows only what the name resolves to; it does not prove the VPS has no public IPv6 address (§14 inventories that separately). Verify from your Mac, before anything else:

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
sudo chmod 0700 /home/deploy                      # explicit: the home directory is private (Ubuntu's default is 0750)
sudo install -d -m 700 -o deploy -g deploy /home/deploy/.ssh /home/deploy/.docker
sudo -u deploy sh -c 'umask 077; cat > ~/.ssh/authorized_keys'      # paste the public line, Ctrl-D
sudo sshd -t                                      # no output = the config is valid

# check, do not assume: every line must say "700 deploy" (the file: "600 deploy")
sudo stat -c '%a %U %n' /home/deploy /home/deploy/.ssh /home/deploy/.docker /home/deploy/.ssh/authorized_keys
```

**Second-session test (a NEW terminal, key only):**

```
ssh -i ~/.ssh/kayas-staging-deploy deploy@<IPv4 of the VPS> 'id; docker ps'     # by IP: see the note in §11
```

Only when that works, treat the access as provisioned. `deploy` has no sudo. The checks that need root (`verify-host.sh`) run as `ubuntu`. Confirm the SSH daemon settings (`sudo sshd -T | grep -Ei 'passwordauthentication|kbdinteractive|permitrootlogin|pubkeyauthentication|maxauthtries'`): password off, keyboard-interactive off, root login off, public key on, `maxauthtries 3`. Keep the provider's web console (rescue access) reachable in case you lock yourself out.

## 6. Host checks (as `ubuntu`)

```
sudo ufw status verbose                  # deny incoming; 22, 80, 443 allowed, v4 and v6
sudo systemctl is-active fail2ban unattended-upgrades
timedatectl show -p NTPSynchronized      # yes
free -h; swapon --show; df -h /          # 4 GB + 2 GB swap, 38 GB disk
sudo docker info --format '{{.LoggingDriver}} {{.LiveRestoreEnabled}}'      # json-file true  (ubuntu is not in the docker group: sudo; from §5 on, Docker commands run as deploy)
sudo cat /etc/docker/daemon.json         # json-file, max-size 10m, max-file 3, live-restore
```

**Docker bypasses UFW** for published ports (it writes its own iptables rules). This stack publishes only the proxy's 80 and 443, and `verify-host.sh` (step 14) reads every published binding of every container; an external **all-port scan** (step 14) is the independent proof. A provider-level firewall in front of the VPS (22, 80, 443 only) is a second layer if the provider offers one.

Resource budget (the compose limits add up to 2.75 GB for db + app + proxy, plus up to 1 GB for a maintenance job, on a 4 GB host with 2 GB swap): db 1 GB, app 1.5 GB (`--max-old-space-size=1024`), proxy 256 MB. Watch `docker stats --no-stream` and `dmesg | grep -i oom` during the first sessions. Disk: Docker logs are capped (10 MB × 3 per service); the images are about 1.7 GB.

## 7. Get the pinned release onto the VPS (as `deploy`)

The repository is private. Use a **read-only deploy key** for it, created on the VPS. Two different accounts take part; the first block needs sudo, the second does not (`deploy` has no sudo).

**As `ubuntu` (sudo):**

```
sudo install -d -m 755 -o deploy -g deploy /srv/kayas
```

**As `deploy`** (a new session: `ssh -i ~/.ssh/kayas-staging-deploy deploy@<IPv4 of the VPS>`, by IP, §11; the key name is the one from §5):

```
ssh-keygen -t ed25519 -f ~/.ssh/kayas-repo-readonly -C "kayas staging read-only"
cat ~/.ssh/kayas-repo-readonly.pub     # the owner adds it as a READ-ONLY deploy key of the GitHub repository
( umask 077; printf 'Host github.com\n  IdentityFile ~/.ssh/kayas-repo-readonly\n  IdentitiesOnly yes\n' >> ~/.ssh/config )
ssh -T git@github.com                  # first contact: compare the fingerprint with the one GitHub publishes before you answer yes
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
# after logout there must be no stored credential: the "auths" object is empty (do NOT use `grep -c auth`: it counts the word "auths" and prints 1 even when empty)
if [ ! -e ~/.docker/config.json ] || grep -Eq '"auths":[[:space:]]*\{\}' ~/.docker/config.json; then echo "no stored registry credential"; else echo "STILL LOGGED IN: run docker logout ghcr.io"; fi
# expected output: no stored registry credential
```

Linux has no OS keychain for Docker by default: while logged in, the token sits in `~/.docker/config.json` (mode 0600, under `/home/deploy`, mode 0700). Logging out right after the pull keeps it off the disk; log in again for an upgrade. Never type the token as an argument.

Record the approval and check the image. The check reads the **actual image**, not the source tree, and it fails by exit status (a printed list that nobody reads is not a check):

```
./scripts/ops/approve-release.sh <commit> ghcr.io/aliescoobs-sudo/kayas@sha256:<digest> linux/amd64 <run id>
img=ghcr.io/aliescoobs-sudo/kayas@sha256:<digest>
docker image inspect --format '{{.Os}}/{{.Architecture}}' "$img" | grep -qx 'linux/amd64' && echo "platform ok"
docker run --rm --pull=never --entrypoint sh "$img" -c '
  bad=0
  for p in e2e e2e-staging tests imports import-work keys reports playwright.config.ts playwright.staging.config.ts vitest.config.ts; do
    [ -e "/app/$p" ] && { echo "FORBIDDEN path: /app/$p"; bad=1; }
  done
  # secret env files are forbidden; the two EXAMPLE files may exist (they hold no secret) and are the only ones allowed
  for f in /app/.env /app/.env.*; do
    [ -e "$f" ] || continue
    case "$f" in /app/.env.example|/app/.env.staging.example) ;; *) echo "FORBIDDEN env file: $f"; bad=1 ;; esac
  done
  # /app/backups is created empty on purpose (the backup job mounts over it); anything inside it is wrong
  [ -z "$(ls -A /app/backups 2>/dev/null)" ] || { echo "FORBIDDEN: /app/backups is not empty"; bad=1; }
  t=$(find /app \( -path /app/node_modules -o -path /app/.next \) -prune -o \( -name "*.test.ts" -o -name "*.test.tsx" -o -name "*.spec.ts" \) -print | head -n 3)
  [ -z "$t" ] || { echo "FORBIDDEN test source: $t"; bad=1; }
  exit $bad'
echo "image content check exit status: $?"        # must be 0; anything else = do not use this digest
```

(The same check, run on an image built before `e2e-staging` was added to `.dockerignore`, prints `FORBIDDEN path: /app/e2e-staging` and exits 1; `scripts/dockerignore.test.ts` also fails the build if a test source would enter the image.)

## 9. Private configuration (as `deploy`, in `/srv/kayas`)

```
APP_DOMAIN=kayas.aliobsil.com ./scripts/staging/init-env.sh
ls -l .env.staging .env.staging.ops      # -rw------- both
```

`init-env.sh` makes both files exclusively and private from the first byte (it sets `umask 077` itself), draws fresh random secrets (URL-safe database passwords), sets the exact origin `https://kayas.aliobsil.com`, and prints no secret. It contains **no** image, **no** provider key, **no** VAPID key and **no** Basic hash. Do not edit these files by hand to "fix" a warning: if validation refuses a combination, the compose file is what changes, never the guard. There is no key escrow for staging: lost keys mean reset.

## 10. A genuinely new storage (check, do not assume)

```
bad=0
for v in kayas-staging_pgdata kayas-staging_filestore kayas-staging_accounts kayas-staging_caddy_data; do
  docker volume inspect "$v" >/dev/null 2>&1 && { echo "IN USE: $v"; bad=1; }      # quiet when the name is free
done
[ -z "$(docker volume ls -q --filter name=kayas-staging)" ] || { echo "other kayas-staging volumes exist"; bad=1; }
[ -z "$(docker ps -aq --filter label=com.docker.compose.project=kayas-staging)" ] || { echo "kayas-staging containers exist"; bad=1; }
echo "storage check exit status: $bad"      # must be 0 before the first start; anything else: scripts/staging/reset.sh, or stop
```

The compose project `kayas-staging` has its own database, filestore, accounts and Caddy volumes, shared with nothing (not production, not the local training stack). The database container writes a one-time **birth marker** the first time it initialises an empty volume; the seed refuses a database without it. The marker is a consumable marker, not proof of provenance: "this volume is new" is **your** check, the command above.

## 11. The Basic Auth gate (as `deploy`, in a real terminal)

Run this in the **deploy terminal you already have open** (the same session you used for the clone). If you need a new one, connect **by IP address**: the owner's network (NAT64) cannot resolve the host name for ssh, so use `ssh -t -i ~/.ssh/kayas-staging-deploy deploy@<IPv4 of the VPS>` (the name works for the browser and `curl`, not for ssh from that network).

```
cd /srv/kayas && ./scripts/staging/make-basic.sh
```

It asks for a user name and a password (at least 16 characters) at **hidden** prompts, computes the bcrypt hash with Caddy's own tool in a throwaway container (the password reaches it on stdin, never as an argument), and writes `staging/basic-auth.caddy` atomically. Use a strong password **different from every app password**; store it in the owner's password manager. The hash is a **file**, not an environment variable, because a bcrypt hash contains `$` and Compose would mangle it. The gate covers **every** path: pages, RSC, static files, the app's login, the phone endpoints, the APIs and every error page, with no exemption. Only Caddy's own certificate challenge is answered before the gate, and it never reaches the app.

**The file is mode 0644, on purpose (decision 228).** The proxy container is hardened (`cap_drop: ALL`, so its root has no `DAC_OVERRIDE`) and the file belongs to the `deploy` user, so a 0600 file is "permission denied" for Caddy and the proxy restarts in a loop. The file holds only a **bcrypt hash** of a password of at least 16 characters, never the password, in a directory (`staging/`) that nobody but `deploy` can write. The cost: other local users of the VPS could read the hash (a single-admin host: acceptable for fictitious data; a production host would need another design). `dc.sh` refuses the file when it is not readable by others, is writable by group or others, belongs to someone else, is a link or a directory.

**Running it again** (to change the password) is safe: `KAYAS_BASIC_REPLACE=1 ./scripts/staging/make-basic.sh`. The proxy container sees the directory read-only, and a new file is a new inode, so a running proxy is **recreated** by the script itself through `dc.sh` (`up -d --force-recreate --wait proxy`); you do not have to do anything else. If the proxy is not running, `up.sh` starts it with the new hash.

**Reading this guide on the VPS:** `sed -n '/^## 11/,/^## 12/p' docs/STAGING-VPS.md` prints one section (change the numbers).

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

**If the proxy restarts in a loop** (`dc.sh ps` shows it restarting or unhealthy; `up.sh` stops with "the proxy did not start correctly"): run `./scripts/staging/dc.sh logs --tail 30 proxy`. The message `Could not import /etc/caddy/staging/basic-auth.caddy: open …: permission denied` means the hash file is not readable by the hardened proxy: check `ls -l staging/basic-auth.caddy` (it must be `-rw-r--r--` and owned by `deploy`) and run `./scripts/staging/make-basic.sh` again with `KAYAS_BASIC_REPLACE=1` (it writes the right mode and recreates the proxy). Do **not** add capabilities to the compose file to "fix" this. `up.sh` also checks, from inside the container, that the Caddyfile and the hash are readable and that Caddy answered on its own health endpoint.

Then clear the terminal. Expected: the red banner "Version de formation — données fictives" on every page; reserved training accounts only (every address ends with the domain in `TRAINING_EMAIL_DOMAIN`, `src/lib/training.ts:4` — compare with that constant, not with a name remembered from an older version); no outbound call.

## 13. Owner and admin TOTP (through the protected HTTPS site)

Do this **before** giving the address to anyone. In a browser: `https://kayas.aliobsil.com` → the browser asks for the Basic user/password → the app's own login (owner, then admin, with the password from `show-accounts.sh`) → enrol the authenticator (QR code or key on your own phone) and store the recovery codes. Finance needs a real second factor even in training. Repeat for the admin account.

## 14. External checks — before the address is shared

**Caddy's log does not print a certificate line in this logging configuration** (there is no access log and the default level hides the issuance). Do not wait for one; the reliable proof is the external checks below. Never use `-k`/`--insecure`: a certificate error is a finding, not something to skip.

From **another machine** (your Mac, on a different network if possible). `curl` asks for the password when you give `-u user` without it, so it never enters the shell history.

```
H=kayas.aliobsil.com
curl -sS -o /dev/null -w '%{http_code}\n' https://$H/                   # 401   (no credentials)
curl -sS -u 'USER' -o /dev/null -w '%{http_code}\n' https://$H/         # hidden password prompt (never on the command line): 307 or 200
curl -sSI http://$H/ | head -n3                                          # 308, Location: https://$H/
curl -sI https://$H/ | head -n1                          # HTTP/2 401   (no credentials)
curl -sI -u 'wronguser:wrongpass' https://$H/fr/login | head -n1       # 401
curl -s -o /dev/null -w '%{http_code}\n' -u 'user' https://$H/fr/login   # prompts; 200 and the app's login page
curl -s -o /dev/null -w '%{http_code}\n' -u 'user' https://$H/fr/admin/field   # 307: valid Basic still needs an app session
curl -sS -o /dev/null -w '%{http_code}\n' https://<IPv4 of the VPS>/    # must NOT print 200: curl fails the certificate check (exit 60) because the name does not match; never add -k
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: other.example' http://<IPv4>/ # 404
openssl s_client -connect $H:443 -servername $H </dev/null 2>/dev/null | openssl x509 -noout -issuer -dates   # a Let's Encrypt certificate, valid
nmap -Pn -p- <IPv4 of the VPS>                           # ALL ports: only 22, 80, 443 open
```

On the VPS, as `ubuntu`: `sudo /srv/kayas/scripts/ops/verify-host.sh --staging` (reads `sshd -T`, judges every published binding of every container one by one, reads the host listeners; any docker error is a failure, not an empty list). **IPv6 is inventoried independently of DNS.** No AAAA record only says what the name resolves to; the VPS may still have a public IPv6 address (UFW has v6 rules). As `ubuntu`: `ip -6 -o addr show scope global` lists every global IPv6 address of the host (also look at the provider's panel). If the list is empty, record "none". For **every** global address that exists, scan it from outside exactly as the IPv4 one (`nmap -6 -Pn -p- <address>`, and the `curl` checks against `https://[<address>]/`): only 22, 80 and 443 may answer, and 80/443 must not serve the site by a bare address. Compose publishes on IPv4 addresses (`0.0.0.0`); an IPv6 answer on 80/443 would be a finding to investigate, not to ignore.

Forged `X-Forwarded-For`, `Host` and `Authorization` headers never reach the app (proved against the real `Caddyfile.staging` in the local rehearsal; the 401 gate and the app's one-hop trust are the same configuration).

## 15. Phones and the field PWA behind Basic Auth

- A phone's browser shows its own username/password prompt the first time. What happens next is browser behaviour that this project does **not** control, so treat each point as an **acceptance check to observe on the supported phones**, not as a guarantee: whether the credentials are kept for the session, whether closing the browser evicts them, and whether an installed home-screen PWA asks again after a restart or after the credentials expire. Write down what you see on each phone model. The local desktop rehearsal says nothing about phones.
- Basic credentials and the app's login are two separate things. **Forgetting or evicting the Basic credential is not an app logout**: the app session (its cookie) is untouched, and the other way round. Give the Basic credentials and the app credentials as two separate things.
- The field PWA (driver page, service worker, manifest) is expected to work once Basic is accepted: the desktop rehearsal's browser test registers the service worker through the gate, and without credentials the script is refused (401). Confirm it on a phone. If a phone says "login failed" after several tries, it is the **app's** per-IP lockout, not Basic Auth: wait ~15 minutes.
- Do not ask for exemptions of "just the manifest" or "just the phone login": there are none.

## 16. Reboot rehearsal and day-to-day

```
sudo reboot            # as ubuntu
# after the VPS is back (2-3 minutes):
ssh -i ~/.ssh/kayas-staging-deploy deploy@<IPv4 of the VPS> 'cd /srv/kayas && ./scripts/staging/dc.sh ps'     # db, app, proxy: running, healthy
# then repeat the 401 / 200 checks of §14 from outside. No manual step may be needed.
```

All services restart by themselves (`restart: unless-stopped`; Docker starts at boot; `live-restore` keeps containers across a daemon restart). Logs: `./scripts/staging/dc.sh logs --since 1h app` (sensitive: they can contain request metadata; the Caddy log carries no `Authorization`). Disk and memory: `df -h /`, `docker system df`, `docker stats --no-stream`. The proxy has a health check; a hung app is seen by `ps` (healthy → unhealthy) but not restarted by Docker: restart it with `./scripts/staging/dc.sh up -d --force-recreate app`.

**Resetting** (staging is disposable): `./scripts/staging/reset.sh` (typed confirmation `RESET-STAGING`; deletes the database, documents and seed credentials, keeps the certificates), then `./scripts/staging/up.sh`.

**Upgrading to a new release** is a reset plus a new approval. The order matters: nothing is deleted before the next release is known to exist and to be pullable.

1. On the Mac, approve the next release as in §3 (green run for the exact commit; commit, digest, platform, run id).
2. As `deploy`, in `/srv/kayas`: `git fetch origin` and verify the next commit exists (`git cat-file -e <next commit>^{commit}`) and is the approved one. Do not check it out yet.
3. Pull the next private digest **now**: the registry login was removed after the last pull, so repeat the token handling of §8 (`docker login`, `docker pull ghcr.io/aliescoobs-sudo/kayas@sha256:<next digest>`, `docker logout`), then repeat the image content check of §8 on it.
4. Only then discard the old data, still under the **old** approval (the wrappers need it): `./scripts/staging/reset.sh`.
5. Replace the approval: `./scripts/ops/approve-release.sh <next commit> ghcr.io/aliescoobs-sudo/kayas@sha256:<next digest> linux/amd64 <run id> --replace`.
6. `git checkout --detach <next commit>`, then `./scripts/staging/up.sh`.

If step 2 or 3 fails, nothing has been deleted and the running release is untouched. **Never restore a database into staging**, and never point a real-data install at a staging volume.

## 17. What was hardened, and what could not be

Applied in `docker-compose.staging.yml` and proven on a real local run (CP-STAGING): `no-new-privileges` on every service; `cap_drop: ALL` with only what is needed added back (PostgreSQL: CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID; Caddy: NET_BIND_SERVICE; the credentials-folder job: CHOWN and FOWNER, on that one run only); read-only root file systems with small tmpfs mounts (the app needs `/tmp`, `/app/.next/cache` and one `exec` tmpfs for the SWC native addon that loads `next.config.ts`); memory, process and CPU limits; bounded `json-file` logs; the database and the app publish no port; the proxy is the only published service; Caddy's admin API is off, the request body is capped (12 MB), header/body/idle timeouts are set; no access log. The same hardening is in `docker-compose.prod.yml`, asserted by `docker compose config` and `validate-compose.py`, but **not** run with `REAL_DATA`.

**Not applied:** read-only root for the production `ops`/`bootstrap`/`backup` containers (their real import and backup paths were not exercised read-only); user namespaces / rootless Docker; seccomp or AppArmor profiles beyond Docker's defaults; Docker secrets instead of env variables; image signature verification (the digest and the CI run are the only provenance); a separate Docker network policy beyond `internal`/`edge`; log shipping and alerting (staging has none).

## 18. The wrappers refuse, on purpose

`scripts/staging/dc.sh` and `ops.sh` refuse: an `APP_IMAGE` or `COMPOSE_*` in the shell, an `APP_IMAGE` in any env file, a missing/malformed `release/APPROVED`, host files that are not at the approved commit or are edited, options of `run`/`exec` that add a mount, a variable or a privilege, `down -v`, and any effective configuration that is not exactly the expected one. A refusal happens **before** a container exists. If a wrapper refuses something you expected to work, the answer is to fix the input, not to bypass the wrapper.
