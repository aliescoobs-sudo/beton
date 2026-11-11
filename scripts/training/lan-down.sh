#!/usr/bin/env bash
# Closes the local-network door of the training instance (T11b): stops the `lan-proxy`, takes LAN_BIND_IP out of .env.training and puts the app
# back on its local address (http://localhost:3000). The data and the certificate authority are kept (the authority is in the volume lan_caddy_data;
# `docker volume rm kayas-training_lan_caddy_data` forgets it, after which phones must trust a new one).
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."
./scripts/training/dc.sh down-lan || true
[ -w .env.training ] && [ ! -L .env.training ] || { echo "lan-down.sh: .env.training missing or a link" >&2; exit 1; }
tmp=$(mktemp ./.env.training.XXXXXX)
trap 'rm -f "$tmp"' EXIT
{ grep -v '^LAN_BIND_IP=' .env.training || true; } > "$tmp"
chmod 600 "$tmp"
mv -f "$tmp" .env.training
trap - EXIT
./scripts/training/set-url.sh http://localhost:3000
echo "lan-down.sh: the local-network door is closed; the instance answers on http://localhost:3000 only."
