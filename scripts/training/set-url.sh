#!/usr/bin/env bash
# Sets the public address of the training instance (the Tailscale Funnel URL, or a VPS domain) and restarts the app.
#   ./scripts/training/set-url.sh https://imac.tail1234.ts.net
set -euo pipefail
# R11-03: the file holds every app secret. Everything this script creates is private from its first byte (umask 077, and mktemp makes
# its file with O_EXCL and mode 0600, so a pre-existing or symlinked name is never reused), then replaces the old file atomically.
umask 077
cd "$(dirname "$0")/../.."
url="${1:?usage: set-url.sh https://<public address>}"
case "$url" in http://127.0.0.1*|http://localhost*|https://?*) ;; *) echo "set-url.sh: give the full https:// address (no trailing slash)" >&2; exit 2;; esac
url="${url%/}"
[ -w .env.training ] || { echo "set-url.sh: .env.training not found: run init-env.sh first" >&2; exit 1; }
[ ! -L .env.training ] || { echo "set-url.sh: .env.training is a symbolic link: refusing" >&2; exit 1; }
tmp=$(mktemp ./.env.training.XXXXXX)
trap 'rm -f "$tmp"' EXIT
{ grep -v '^APP_BASE_URL=' .env.training || true; echo "APP_BASE_URL=$url"; } > "$tmp"
chmod 600 "$tmp"
mv -f "$tmp" .env.training
trap - EXIT
./scripts/training/dc.sh up -d app
echo "set-url.sh: the app now accepts requests from $url"
