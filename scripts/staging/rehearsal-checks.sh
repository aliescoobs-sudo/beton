#!/usr/bin/env bash
# The checks of the LOCAL rehearsal (T10g, R19B-01): run by scripts/staging/rehearse.sh against the real staging compose and the real Caddy.
# They need REHEARSAL_HOST / _HTTP / _HTTPS / _USER / _PASSWORD / _WRONG in the environment and print no credential.
set -uo pipefail
cd "$(dirname "$0")/../.."
: "${REHEARSAL_HOST:?}" "${REHEARSAL_HTTP:?}" "${REHEARSAL_HTTPS:?}" "${REHEARSAL_USER:?}" "${REHEARSAL_PASSWORD:?}" "${REHEARSAL_WRONG:?}"
dc=./scripts/staging/dc.sh
H="$REHEARSAL_HOST"
URL="https://$H:$REHEARSAL_HTTPS"
RES=(--resolve "$H:$REHEARSAL_HTTPS:127.0.0.1" --resolve "$H:$REHEARSAL_HTTP:127.0.0.1")
tmp="$(mktemp -d .logs/rehearsal-checks.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
fails=0
ok() { echo "ok    $1"; }
bad() { echo "FAIL  $1"; fails=$((fails+1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', wanted '$3')"; fi; }
# Caddy's own CA, so that TLS is verified for real (no -k anywhere on the https checks that matter)
$dc exec -T proxy cat /data/caddy/pki/authorities/local/root.crt > "$tmp/ca.pem" 2>/dev/null
[ -s "$tmp/ca.pem" ] && ok "got the rehearsal CA from the proxy volume" || { bad "could not read the rehearsal CA"; exit 1; }
cu() { curl -sS --max-time 20 "${RES[@]}" --cacert "$tmp/ca.pem" "$@"; }
code() { cu -o /dev/null -w '%{http_code}' "$@"; }
auth=(-u "$REHEARSAL_USER:$REHEARSAL_PASSWORD")
wrong=(-u "$REHEARSAL_USER:$REHEARSAL_WRONG")

# --- A Next-side counter. A request that reaches the app's phone sign-in inserts one row into login_attempt (the per-IP reservation, made before any
# other work). Rows are read from the database container with the superuser login (never printed). With the Origin header the app's own origin check
# passes, so a request that was NOT stopped by the gate would be counted.
attempts() { $dc exec -T db psql -U postgres -d belgobeton -Atc 'select count(*) from login_attempt' 2>/dev/null | tr -d '\r' | tail -n1; }
ORIGIN=(-H "Origin: $URL")
paths=(/ /fr/login /fr/driver /fr/admin/field /api/auth/get-session /api/field/session /api/health/ready /api/health/live /sw.js /driver-sw.js /app.webmanifest /robots.txt /_next/static/chunks/none.js /nonexistent-path "//" "/%2e%2e/%2e%2e/etc/passwd" /api/finance/x /api/trips/x /api/assistant/x /api/push/x)
# 1. no credentials / wrong credentials: 401 with a challenge, everywhere, on every method, and NOTHING reaches the app
before="$(attempts)"
for p in "${paths[@]}"; do
  check "no credentials  GET  $p" "$(code "$URL$p")" 401
  check "wrong credentials GET $p" "$(code "${wrong[@]}" "$URL$p")" 401
done
for m in POST PUT PATCH DELETE OPTIONS; do
  for p in /api/auth/sign-in/email /api/field/login /api/field/sync /api/field/bl-photo /api/field/logout /api/push/x; do
    check "no credentials  $m $p" "$(code -X "$m" "${ORIGIN[@]}" -H 'content-type: application/json' --data '{"code":"CH-01","pin":"000000"}' "$URL$p")" 401
    check "wrong credentials $m $p" "$(code "${wrong[@]}" -X "$m" "${ORIGIN[@]}" -H 'content-type: application/json' --data '{"code":"CH-01","pin":"000000"}' "$URL$p")" 401
  done
done
check "no credentials  HEAD /" "$(code -I "$URL/")" 401
check "the 401 carries the Basic challenge" "$(cu -D - -o /dev/null "$URL/" | tr -d '\r' | grep -ci '^www-authenticate: basic')" 1
# oversized and slow-style probes are also stopped at the gate
check "no credentials  big body" "$(head -c 2000000 /dev/zero | code -X POST -H 'content-type: application/octet-stream' --data-binary @- "$URL/api/field/bl-photo")" 401
after="$(attempts)"
check "NOTHING reached the app: login_attempt rows unchanged ($before) after the whole refused burst, phone sign-in included" "$after" "$before"
# positive control: the SAME request with the right Basic credentials does reach the app and is counted
st="$(code "${auth[@]}" -X POST "${ORIGIN[@]}" -H 'content-type: application/json' --data '{"code":"CH-01","pin":"000000"}' "$URL/api/field/login")"
check "positive control: the same sign-in with valid Basic reaches the app (counted)" "$(attempts)" "$((before+1))"
case "$st" in 401|403|429) ok "field sign-in with a wrong PIN is refused by the app ($st), not by the gate";; *) bad "field sign-in answered $st";; esac

# 2. headers on Caddy's own 401
hdr="$(cu -D - -o /dev/null "$URL/")"
for h in 'x-content-type-options: nosniff' 'strict-transport-security: max-age=' 'x-frame-options: deny' 'referrer-policy: no-referrer'; do
  echo "$hdr" | tr -d '\r' | grep -qi "^$h" && ok "401 carries $h" || bad "401 lacks $h"
done
echo "$hdr" | grep -qi '^server:' && bad "401 exposes a Server header" || ok "no Server header"

# 3. HTTP -> HTTPS (the redirect is Caddy's and says nothing about the app); an unknown name or the bare address is not served
loc="$(cu -D - -o /dev/null "http://$H:$REHEARSAL_HTTP/" | tr -d '\r' | sed -n 's/^[Ll]ocation: //p')"
# Caddy leaves the port out of its automatic redirect when it is not 443; on the VPS the port IS 443, so scheme, host and path are what is checked
case "$loc" in "https://$H/"|"https://$H:$REHEARSAL_HTTPS/") ok "HTTP redirects to https://$H (Location: $loc)";; *) bad "HTTP redirect goes to '$loc'";; esac
check "HTTP unknown Host -> 404" "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example' "http://127.0.0.1:$REHEARSAL_HTTP/")" 404
check "HTTP bare address -> 404" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$REHEARSAL_HTTP/")" 404
if curl -sS -k --max-time 10 -o /dev/null "https://127.0.0.1:$REHEARSAL_HTTPS/" 2>/dev/null; then bad "HTTPS by bare address was served"; else ok "HTTPS by bare address (no matching name) is not served"; fi
if curl -sS -k --max-time 10 --resolve "other.localhost:$REHEARSAL_HTTPS:127.0.0.1" -o /dev/null "https://other.localhost:$REHEARSAL_HTTPS/" 2>/dev/null; then bad "HTTPS for another name was served"; else ok "HTTPS for another name is not served"; fi
# 4. valid credentials: the app answers, and the application's own authentication is still in force
body="$tmp/login.html"
check "valid credentials  /fr/login -> 200" "$(cu "${auth[@]}" -o "$body" -w '%{http_code}' "$URL/fr/login")" 200
grep -qi 'formation' "$body" && ok "the login page is the app's, with the training banner" || bad "the login page lacks the training banner"
check "valid credentials  /api/health/ready is still hidden (404)" "$(code "${auth[@]}" "$URL/api/health/ready")" 404
st="$(code "${auth[@]}" "$URL/fr/admin/field")"
case "$st" in 307|308|302|303) ok "valid Basic does not open a protected page (app redirect $st)";; *) bad "protected page without app session answered $st";; esac
st="$(cu "${auth[@]}" -D "$tmp/h" -o /dev/null -w '%{http_code}' "$URL/api/field/session")"
if grep -qi '^www-authenticate: basic' "$tmp/h"; then bad "app endpoint answered with the Basic challenge"; else ok "api/field/session is answered by the APP ($st), not by the gate"; fi
case "$st" in 401|403|404) ok "api/field/session without a phone session is refused by the app";; *) bad "api/field/session answered $st";; esac
# a static asset: gated without Basic, served with it
asset="$(grep -o '/_next/static/[^"]*\.js' "$body" | head -n1)"
if [ -n "$asset" ]; then
  check "static asset without credentials" "$(code "$URL$asset")" 401
  check "static asset with credentials" "$(code "${auth[@]}" "$URL$asset")" 200
else bad "no static asset found in the login page"; fi
check "valid credentials  service worker script /sw.js" "$(code "${auth[@]}" "$URL/sw.js")" 200
check "valid credentials  manifest" "$(code "${auth[@]}" "$URL/app.webmanifest")" 200

# 5. what is published: only the proxy, only two ports, loopback in the rehearsal (80/443 on the VPS)
pub="$(docker ps --filter label=com.docker.compose.project=kayas-staging --format '{{.Label "com.docker.compose.service"}}|{{.Ports}}')" || pub=""
echo "$pub" | grep -E '^(db|app)\|' | grep -q -- '->' && bad "db or app publishes a host port" || ok "db and app publish no host port"
pp="$(echo "$pub" | grep '^proxy|' | tr ',' '\n' | grep -- '->' | sed 's/^[^|]*|//; s/^ *//' | sort | tr '\n' ' ')"
check "proxy publishes exactly the two ports (loopback)" "$pp" "127.0.0.1:$REHEARSAL_HTTP->$REHEARSAL_HTTP/tcp 127.0.0.1:$REHEARSAL_HTTPS->$REHEARSAL_HTTPS/tcp "

# 5b. the SAME client address is seen by the app whatever X-Forwarded-For the client sends (one distinct ip_hmac across forged and plain sign-ins)
db_distinct() { $dc exec -T db psql -U postgres -d belgobeton -Atc 'select count(distinct ip_hmac) from login_attempt' 2>/dev/null | tr -d '\r' | tail -n1; }
code "${auth[@]}" -X POST "${ORIGIN[@]}" -H 'X-Forwarded-For: 6.6.6.6, 7.7.7.7' -H 'content-type: application/json' --data '{"code":"CH-02","pin":"000000"}' "$URL/api/field/login" >/dev/null
code "${auth[@]}" -X POST "${ORIGIN[@]}" -H 'X-Forwarded-For: 8.8.8.8' -H 'content-type: application/json' --data '{"code":"CH-03","pin":"000000"}' "$URL/api/field/login" >/dev/null
check "forged X-Forwarded-For values all count against ONE client address" "$(db_distinct)" 1

# 6. a forged X-Forwarded-For, Host and Authorization never reach an upstream: the real Caddyfile.staging in front of an echo server
docker rm -f kayas-rehearsal-echo kayas-rehearsal-proxy2 >/dev/null 2>&1
img="$(sed -n 's/^REHEARSAL_IMAGE=//p' .env.staging)"
docker run -d --name kayas-rehearsal-echo --network kayas-staging_edge --network-alias echo --read-only "$img" \
  node -e "require('http').createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify(q.headers))}).listen(3000)" >/dev/null
sed 's#app:3000#echo:3000#' Caddyfile.staging > "$tmp/Caddyfile.echo"
docker run -d --name kayas-rehearsal-proxy2 --network kayas-staging_edge -e APP_DOMAIN="$H" -e STAGING_TLS=internal -e STAGING_HTTP_PORT=18090 -e STAGING_HTTPS_PORT=18444 \
  -p 127.0.0.1:18090:18090 -p 127.0.0.1:18444:18444 -v "$PWD/$tmp/Caddyfile.echo:/etc/caddy/Caddyfile:ro" -v "$PWD/staging:/etc/caddy/staging:ro" \
  --read-only --tmpfs /tmp --tmpfs /config --tmpfs /data caddy:2-alpine >/dev/null
for _ in $(seq 1 30); do curl -s -o /dev/null --max-time 2 -k --resolve "$H:18444:127.0.0.1" "https://$H:18444/" && break; sleep 1; done
echo_json="$(curl -sS -k --max-time 10 --resolve "$H:18444:127.0.0.1" "${auth[@]}" -H 'X-Forwarded-For: 6.6.6.6' -H 'X-Forwarded-Host: evil.example' -H 'X-Forwarded-Proto: http' -H 'X-Real-Ip: 6.6.6.6' "https://$H:18444/echo")"
xff="$(printf '%s' "$echo_json" | python3 -I -c "import sys,json; h=json.load(sys.stdin); print(h.get('x-forwarded-for','')); " 2>/dev/null)"
case "$xff" in ''|*6.6.6.6*|*,*) bad "x-forwarded-for reached the upstream as '$xff'";; *) ok "a forged X-Forwarded-For is replaced by the connection peer";; esac
printf '%s' "$echo_json" | python3 -I -c "import sys,json; h=json.load(sys.stdin); sys.exit(0 if 'authorization' not in h else 1)" && ok "the Basic credentials are not forwarded to the app" || bad "Authorization reached the upstream"
printf '%s' "$echo_json" | python3 -I -c "import sys,json; h=json.load(sys.stdin); sys.exit(0 if h.get('x-forwarded-host')=='$H' and h.get('x-forwarded-proto')=='https' else 1)" && ok "forged X-Forwarded-Host / -Proto are replaced" || bad "X-Forwarded-Host/Proto were not replaced"
docker rm -f kayas-rehearsal-echo kayas-rehearsal-proxy2 >/dev/null 2>&1

# 7. the container hardening is real, not only declared
for s in db app proxy; do
  id="$($dc ps -q "$s")"
  info="$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}|{{.HostConfig.Privileged}}|{{.HostConfig.Memory}}|{{.HostConfig.PidsLimit}}|{{json .HostConfig.CapDrop}}|{{json .HostConfig.SecurityOpt}}|{{.HostConfig.LogConfig.Config}}' "$id")"
  echo "$info" | grep -q '|false|' && echo "$info" | grep -q 'no-new-privileges' && echo "$info" | grep -q '"ALL"' && echo "$info" | grep -q 'max-size:10m' && ok "$s: no-new-privileges, cap_drop ALL, not privileged, bounded logs" || bad "$s: hardening not applied ($info)"
  mem="$(echo "$info" | cut -d'|' -f3)"; [ "${mem:-0}" -gt 0 ] && ok "$s: memory limit $mem" || bad "$s: no memory limit"
done
uid="$($dc exec -T app id -u | tr -d '\r')"; check "the app runs as uid 10001" "$uid" 10001
[ "$($dc exec -T app sh -c 'touch /app/x 2>&1 >/dev/null; echo $?' | tr -d '\r' | tail -n1)" != 0 ] && ok "the app root filesystem is read-only" || bad "the app root filesystem is writable"
st="$($dc ps --format '{{.Service}}={{.Health}}' | sort | tr '\n' ' ')"
echo "$st" | grep -q 'proxy=healthy' && echo "$st" | grep -q 'app=healthy' && ok "app and proxy are healthy ($st)" || bad "unhealthy: $st"

# 8. logs: no Authorization header and no canary credential in any container log
logs="$($dc logs --no-color 2>&1)"
echo "$logs" | grep -q -F "$REHEARSAL_PASSWORD" && bad "the Basic password is in a container log" || ok "the Basic password is in no container log"
echo "$logs" | grep -qi 'authorization:' && bad "an Authorization header is in a log" || ok "no Authorization header in the logs"

if [ "$fails" -ne 0 ]; then echo "rehearsal checks: $fails FAILED"; exit 1; fi
echo "rehearsal checks: all passed"
