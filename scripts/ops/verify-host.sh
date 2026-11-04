#!/usr/bin/env bash
# Checks the host against what the runbook demands (CODEX-REVIEW-R9 item 11). Run as root on the server, then from ANOTHER machine:
#   nmap -Pn -p 22,80,443,3000,5432 <APP_DOMAIN IPv4>      and the same with the IPv6 address (nmap -6)
# only 22 (from your admin addresses), 80 and 443 may answer. A UFW rule alone does not close a port that Docker publishes.
set -uo pipefail
bad=0
check() { if eval "$2"; then echo "ok    $1"; else echo "FAIL  $1"; bad=1; fi; }
sshd_v=$(sshd -T 2>/dev/null || true)
check "ssh: password authentication off" "echo \"$sshd_v\" | grep -qi '^passwordauthentication no'"
check "ssh: keyboard-interactive off" "echo \"$sshd_v\" | grep -Eqi '^(kbdinteractiveauthentication|challengeresponseauthentication) no'"
check "ssh: root login off" "echo \"$sshd_v\" | grep -Eqi '^permitrootlogin no'"
check "ssh: public key on" "echo \"$sshd_v\" | grep -qi '^pubkeyauthentication yes'"
published=$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -E '0\.0\.0\.0:|:::' | grep -vE ':(80|443)->' || true)
check "docker publishes only 80 and 443" "[ -z \"$published\" ]"
[ -n "$published" ] && echo "$published"
root="$(cd "$(dirname "$0")/../.." && pwd)"
for d in keys reports; do
  check "$d/ is group 10001, mode 2750, not owned by root" "[ \"\$(stat -c '%g %a' \"$root/$d\" 2>/dev/null)\" = '10001 2750' ] && [ \"\$(stat -c '%u' \"$root/$d\")\" != 0 ]"
done
check "unattended security updates present" "dpkg -s unattended-upgrades >/dev/null 2>&1"
check "time sync active" "timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -qi yes"
exit $bad
