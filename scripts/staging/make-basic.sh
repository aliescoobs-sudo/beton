#!/usr/bin/env bash
# Creates staging/basic-auth.caddy: the Basic Auth gate of the staging proxy (T10g, R19B-01/-04). Run it ON the server, under the deploy account, in a
# terminal (a real TTY). The user name and the password are typed at HIDDEN prompts: they are never an argument, never in the shell history, never in
# an environment variable of this script's children. Only a bcrypt hash is stored. The hash is computed by Caddy's own `hash-password` in a throwaway
# container (the password reaches it on stdin; the container has no network and no volume).
#   ./scripts/staging/make-basic.sh            (asks for the user name, then the password twice)
# Batch use (a securely supplied stdin, no TTY): the user name on the first line, the password on the second, the same password on the third.
#   KAYAS_BASIC_BATCH=1 ./scripts/staging/make-basic.sh < /secure/pipe
# The file is created private from its first byte (umask 077, then an atomic rename, mode 0600). An existing file is not replaced unless KAYAS_BASIC_REPLACE=1.
set -euo pipefail
cd "$(dirname "$0")/../.."
umask 077
out=staging/basic-auth.caddy
caddy_image="caddy:2-alpine"
if [ -e "$out" ] || [ -L "$out" ]; then
  [ "${KAYAS_BASIC_REPLACE:-}" = 1 ] || { echo "make-basic.sh: $out already exists. To replace it run with KAYAS_BASIC_REPLACE=1." >&2; exit 1; }
  [ -L "$out" ] && { echo "make-basic.sh: $out is a link: refused" >&2; exit 1; }
fi
if [ "${KAYAS_BASIC_BATCH:-}" != 1 ] && { [ ! -t 0 ] || [ ! -t 2 ]; }; then
  echo "make-basic.sh: no terminal. Run it in an interactive terminal (hidden prompts), or set KAYAS_BASIC_BATCH=1 and supply the three lines on stdin." >&2; exit 1
fi
read_secret() { # prompt var : hidden when interactive
  local v
  if [ "${KAYAS_BASIC_BATCH:-}" = 1 ]; then IFS= read -r v || v=""; else IFS= read -r -s -p "$1" v </dev/tty || v=""; printf '\n' >&2; fi
  printf -v "$2" '%s' "$v"
}
user=""; pw1=""; pw2=""
if [ "${KAYAS_BASIC_BATCH:-}" = 1 ]; then IFS= read -r user || user=""; else IFS= read -r -p "Basic Auth user name (letters, digits, - _): " user </dev/tty || user=""; fi
[[ "$user" =~ ^[A-Za-z0-9_-]{3,32}$ ]] || { echo "make-basic.sh: the user name must be 3-32 characters of letters, digits, - or _" >&2; exit 1; }
read_secret "Password (hidden, at least 16 characters): " pw1
read_secret "Password again: " pw2
[ "$pw1" = "$pw2" ] || { echo "make-basic.sh: the two passwords differ" >&2; exit 1; }
[ "${#pw1}" -ge 16 ] || { echo "make-basic.sh: the password must be at least 16 characters" >&2; exit 1; }
tmp="$(mktemp staging/.basic-auth.XXXXXX)"
trap 'rm -f -- "$tmp"' EXIT
hash="$(printf '%s\n' "$pw1" | docker run --rm -i --network none --read-only "$caddy_image" caddy hash-password 2>/dev/null | tail -n1)"
unset pw1 pw2
[[ "$hash" =~ ^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$ ]] || { echo "make-basic.sh: Caddy did not return a bcrypt hash; nothing was written" >&2; exit 1; }
{
  echo '# Basic Auth gate of the staging proxy: a bcrypt HASH only. Made by scripts/staging/make-basic.sh. Never commit this file.'
  echo 'basic_auth bcrypt "KAYAS staging" {'
  printf '\t%s %s\n' "$user" "$hash"
  echo '}'
} > "$tmp"
chmod 600 "$tmp"
mv -f -- "$tmp" "$out"
trap - EXIT
echo "make-basic.sh: wrote $out (mode 0600). The password is not stored anywhere on this host."
