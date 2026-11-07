#!/usr/bin/env bash
# Sets the address the training instance accepts requests from (APP_BASE_URL) and restarts the app. LOCAL ADDRESSES ONLY (R15A-06): the
# training instance is not published, so a public or tunnel address is refused.
#   ./scripts/training/set-url.sh http://localhost:3000
set -euo pipefail
# R11-03: the file holds every app secret. Everything this script creates is private from its first byte (umask 077, and mktemp makes
# its file with O_EXCL and mode 0600, so a pre-existing or symlinked name is never reused), then replaces the old file atomically.
umask 077
cd "$(dirname "$0")/../.."
url="${1:?usage: set-url.sh http://localhost:3000}"
[[ "$url" =~ ^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?/?$ ]] || { echo "set-url.sh: give a local address (http://localhost:3000 or http://127.0.0.1:3000): the training instance is local only, nothing is public" >&2; exit 2; }
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
