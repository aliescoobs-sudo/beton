#!/usr/bin/env bash
# Checks the host against what the runbook demands (CODEX-REVIEW-R9 item 11; T10g R19B-05). Run as root on the server, then from ANOTHER machine:
#   nmap -Pn -p- <APP_DOMAIN IPv4>          (all 65535 ports; and the same with the IPv6 address, nmap -6, when there is one)
# only 22 (from your admin addresses), 80 and 443 may answer. A UFW rule alone does not close a port that Docker publishes.
#
# R19B-05: the Docker inventory FAILS CLOSED. Every published binding of every container is read from `docker inspect` (structured: address, port,
# protocol, IPv4 and IPv6 alike) and judged ONE BY ONE; a line with an allowed port can no longer hide a forbidden one. The only accepted bindings are the
# wildcard addresses on 80 and 443; a binding to an explicit non-loopback host address, to any other port, a container on the host network and a container
# whose bindings cannot be read are failures. Host listeners are read from `ss` and judged too (anything non-loopback besides 22, 80, 443 fails).
#   sudo ./scripts/ops/verify-host.sh [--staging]      (--staging: the staging VPS has no keys/, reports/ or import-work/ folders to judge)
set -uo pipefail
mode_staging=no
[ "${1:-}" = --staging ] && mode_staging=yes
bad=0
check() { if eval "$2"; then echo "ok    $1"; else echo "FAIL  $1"; bad=1; fi; }
fail() { echo "FAIL  $1"; bad=1; }
sshd_v=$(sshd -T 2>/dev/null || true)
check "ssh: password authentication off" "echo \"$sshd_v\" | grep -qi '^passwordauthentication no'"
check "ssh: keyboard-interactive off" "echo \"$sshd_v\" | grep -Eqi '^(kbdinteractiveauthentication|challengeresponseauthentication) no'"
check "ssh: root login off" "echo \"$sshd_v\" | grep -Eqi '^permitrootlogin no'"
check "ssh: public key on" "echo \"$sshd_v\" | grep -qi '^pubkeyauthentication yes'"

# --- Docker: every binding of every container (running or not yet running)
ids=$(docker ps -aq --no-trunc 2>/dev/null) || ids="__FAILED__"
if [ "$ids" = "__FAILED__" ]; then
  fail "docker inventory: 'docker ps' failed (this is not an empty answer)"
elif [ -z "$ids" ]; then
  echo "ok    docker: no container exists"
else
  inspected=$(docker inspect $ids 2>/dev/null) || inspected=""
  if [ -z "$inspected" ]; then
    fail "docker inventory: 'docker inspect' failed or returned nothing"
  else
    verdict=$(printf '%s' "$inspected" | python3 -I -c '
import json, sys
ALLOWED = {"80", "443"}
WILDCARD = {"", "0.0.0.0", "::", "[::]"}
LOOPBACK = {"127.0.0.1", "::1", "[::1]"}
try:
    containers = json.load(sys.stdin)
    assert isinstance(containers, list) and containers
except Exception:
    print("UNREADABLE"); sys.exit(0)
bad, seen = [], 0
for c in containers:
    name = (c.get("Name") or c.get("Id", "?")[:12]).lstrip("/")
    hc = c.get("HostConfig") or {}
    if hc.get("NetworkMode") == "host":
        bad.append(f"{name}: runs on the HOST network (every port it opens is public)")
    if hc.get("Privileged"):
        bad.append(f"{name}: is privileged")
    ports = {}
    for source in ((c.get("NetworkSettings") or {}).get("Ports"), hc.get("PortBindings")):
        for key, binds in (source or {}).items():
            for b in binds or []:
                ports[(key, b.get("HostIp", ""), b.get("HostPort", ""))] = 1
    for (key, ip, port) in ports:
        seen += 1
        if ip in LOOPBACK:
            continue
        if ip not in WILDCARD:
            bad.append(f"{name}: {key} is published on the explicit host address {ip}:{port}")
        elif port not in ALLOWED or not key.endswith("/tcp"):
            bad.append(f"{name}: {key} is published on {ip or chr(42)}:{port} (only 80 and 443 may be)")
print("OK %d" % seen if not bad else "BAD\n" + "\n".join(bad))
' 2>/dev/null) || verdict="UNREADABLE"
    case "$verdict" in
      OK*) echo "ok    docker publishes only 80 and 443 on the wildcard addresses (${verdict#OK } binding(s) read)" ;;
      UNREADABLE) fail "docker inventory: the inspect output could not be parsed" ;;
      *) fail "docker publishes something other than 80/443 on the wildcard addresses"; printf '%s\n' "${verdict#BAD}" | sed '/^$/d; s/^/        /' ;;
    esac
  fi
fi

# --- host listeners (TCP): nothing but 22, 80, 443 on a non-loopback address
listeners=$(ss -H -tln 2>/dev/null) || listeners="__FAILED__"
if [ "$listeners" = "__FAILED__" ]; then
  fail "host listeners: 'ss' failed"
else
  extra=$(printf '%s\n' "$listeners" | awk '{a=$4; sub(/:[0-9]+$/,"",a); p=$4; sub(/^.*:/,"",p); if (a ~ /^(127\.|\[?::1\]?$|localhost)/) next; if (p=="22"||p=="80"||p=="443") next; if (a ~ /^127\.0\.0\.53/) next; print $4}')
  if [ -n "$extra" ]; then fail "host listeners: unexpected non-loopback listener(s):"; printf '%s\n' "$extra" | sed 's/^/        /'; else echo "ok    host listeners: only 22, 80, 443 beyond loopback"; fi
fi

root="$(cd "$(dirname "$0")/../.." && pwd)"
for d in keys reports import-work; do
  [ "$mode_staging" = yes ] && continue
  want="10001 2750"; [ "$d" = import-work ] && want="10001 2770"
  check "$d/ is group 10001, mode ${want#* }, not owned by root" "[ \"\$(stat -c '%g %a' \"$root/$d\" 2>/dev/null)\" = '$want' ] && [ \"\$(stat -c '%u' \"$root/$d\")\" != 0 ]"
done
check "unattended security updates present" "dpkg -s unattended-upgrades >/dev/null 2>&1"
check "time sync active" "timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -qi yes"
exit $bad
