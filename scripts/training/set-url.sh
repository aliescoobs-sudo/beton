#!/usr/bin/env bash
# Sets the public address of the training instance (the Tailscale Funnel URL, or a VPS domain) and restarts the app.
#   ./scripts/training/set-url.sh https://imac.tail1234.ts.net
set -euo pipefail
cd "$(dirname "$0")/../.."
url="${1:?usage: set-url.sh https://<public address>}"
case "$url" in http://127.0.0.1*|http://localhost*|https://?*) ;; *) echo "set-url.sh: give the full https:// address (no trailing slash)" >&2; exit 2;; esac
url="${url%/}"
[ -w .env.training ] || { echo "set-url.sh: .env.training not found: run init-env.sh first" >&2; exit 1; }
grep -v '^APP_BASE_URL=' .env.training > .env.training.new
echo "APP_BASE_URL=$url" >> .env.training.new
chmod 600 .env.training.new && mv .env.training.new .env.training
./scripts/training/dc.sh up -d app
echo "set-url.sh: the app now accepts requests from $url"
