#!/usr/bin/env bash
# Opens the TRAINING instance on the LOCAL NETWORK, for a phone on the same Wi-Fi (T11b). Fictitious data only; the instance stays in training mode.
#   ./scripts/training/lan-up.sh [<private IPv4 of this Mac>]      (default: the address of en0)
# What it does, and nothing else: writes LAN_BIND_IP and APP_BASE_URL=https://<ip>:8443 into .env.training (atomically, mode 0600), starts the
# `lan-proxy` service (Caddy, TLS from its own internal CA, published on the Mac's LOOPBACK 127.0.0.1:8443), starts scripts/training/lan-relay.mjs (a
# plain TCP relay listening on <ip>:8443 only: not on every interface, not on the internet; Colima's VM does not own the Wi-Fi address, so Docker
# cannot bind it) and restarts the app so that it accepts requests from that one origin. The phone must trust the CA once: docs/training/RESEAU-LOCAL.fr.md.
# Only a private address (10.x, 172.16-31.x, 192.168.x) is accepted. It is the operator's job to be on a Wi-Fi they trust, with no port forward
# on the router. Close it again with  ./scripts/training/lan-down.sh
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."
ip="${1:-$(ipconfig getifaddr en0 2>/dev/null || true)}"
[ -n "$ip" ] || { echo "lan-up.sh: no address found for en0: give the Mac's private address (ipconfig getifaddr en0)" >&2; exit 2; }
[[ "$ip" =~ ^(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3})$ ]] \
  || { echo "lan-up.sh: '$ip' is not a private address (10.x, 172.16-31.x, 192.168.x): refused, nothing is opened" >&2; exit 2; }
IFS=. read -r a b c d <<<"$ip"
for o in $a $b $c $d; do [ "$o" -le 255 ] || { echo "lan-up.sh: '$ip' is not an address" >&2; exit 2; }; done
[ -w .env.training ] || { echo "lan-up.sh: .env.training not found: run init-env.sh first" >&2; exit 1; }
[ ! -L .env.training ] || { echo "lan-up.sh: .env.training is a symbolic link: refusing" >&2; exit 1; }
tmp=$(mktemp ./.env.training.XXXXXX)
trap 'rm -f "$tmp"' EXIT
{ grep -v -E '^(APP_BASE_URL|LAN_BIND_IP)=' .env.training || true; echo "LAN_BIND_IP=$ip"; echo "APP_BASE_URL=https://$ip:8443"; } > "$tmp"
chmod 600 "$tmp"
mv -f "$tmp" .env.training
trap - EXIT
./scripts/training/dc.sh up -d app
./scripts/training/dc.sh up-lan
# the relay: one private address, one port; a previous one is stopped, and its stop verified, first
pidfile=.training-lan-relay.pid
./scripts/training/relay-stop.sh >/dev/null || { echo "lan-up.sh: a previous relay could not be stopped" >&2; exit 1; }
mkdir -p .logs
nohup node scripts/training/lan-relay.mjs "$ip" 8443 8443 > .logs/lan-relay.log 2>&1 &
echo $! > "$pidfile"
sleep 1
kill -0 "$(cat "$pidfile")" 2>/dev/null || { echo "lan-up.sh: the relay did not start: see .logs/lan-relay.log" >&2; cat .logs/lan-relay.log >&2; exit 1; }
ok=no
for _ in $(seq 1 "${READY_TRIES:-20}"); do
  if curl -ksS --max-time 5 -o /dev/null -w '%{http_code}' "https://$ip:8443/fr/login" 2>/dev/null | grep -q '^2'; then ok=yes; break; fi
  sleep "${READY_SLEEP:-3}"
done
[ "$ok" = yes ] || { echo "lan-up.sh: https://$ip:8443/fr/login did not answer: look at  ./scripts/training/dc.sh logs lan-proxy" >&2; exit 1; }
cat <<NEXT

The training instance answers on the local network:  https://$ip:8443/fr/login   (red training banner, fictitious data)
This Mac's own browser must use this same address now (the app accepts requests from that one origin only); http://localhost:3000 stops working until
./scripts/training/lan-down.sh.

Phone, once: trust the training certificate authority (docs/training/RESEAU-LOCAL.fr.md):
  ./scripts/training/dc.sh lan-ca > ~/KAYAS-twin/kayas-training-ca.crt     then send that file to the phone (AirDrop) and install + trust it.
The address changes if the router gives this Mac another one: run lan-up.sh again then (and trust nothing new: the authority is kept).
NEXT
