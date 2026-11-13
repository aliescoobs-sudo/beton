#!/usr/bin/env bash
# Creates staging/basic-auth.caddy: the Basic Auth gate of the staging proxy (T10g, R19B-01/-04). Run it ON the server, under the deploy account, in a
# terminal (a real TTY). The user name and the password are typed at HIDDEN prompts: they are never an argument, never in the shell history, never in
# an environment variable of this script's children. Only a bcrypt hash is stored. The hash is computed by Caddy's own `hash-password` in a throwaway
# container (the password reaches it on stdin; the container has no network and no volume).
#   ./scripts/staging/make-basic.sh            (asks for the user name, then the password twice)
# Batch use (a securely supplied stdin, no TTY): the user name on the first line, the password on the second, the same password on the third.
#   KAYAS_BASIC_BATCH=1 ./scripts/staging/make-basic.sh < /secure/pipe
# The file is written while private (umask 077, mode 0600) and then made mode 0644 and renamed atomically. 0644 is deliberate and the smallest change that
# works: the proxy container is hardened (cap_drop ALL, so its root has NO DAC_OVERRIDE) and the file belongs to the deploy user, so a 0600 file is
# "permission denied" for it. The file holds a bcrypt HASH of a password of at least 16 characters (never the password), in a directory that is not writable
# by anyone but its owner; the cost is that other local users of the host can read the hash (a single-admin VPS; decision 228).
# An existing file is not replaced unless KAYAS_BASIC_REPLACE=1. When the proxy already runs, the script recreates it through ./scripts/staging/dc.sh:
# the rename gives the file a new inode and Caddy only reads it at start (its admin API is off, so there is no reload). If the status of the proxy cannot be
# read, or the recreation or the health confirmation fails, the script exits NON-ZERO: the old Basic credential may still work (R21-01).
set -euo pipefail
cd "$(dirname "$0")/../.."
umask 077
out=staging/basic-auth.caddy
caddy_image="caddy:2-alpine"
dir_mode="$(stat -c '%a' staging 2>/dev/null || stat -f '%Lp' staging)"
if [ -L staging ] || [ ! -d staging ] || [ $((8#$dir_mode & 8#022)) -ne 0 ] || [ $((8#$dir_mode & 8#001)) -eq 0 ]; then
  echo "make-basic.sh: staging/ must be a real directory, not writable by group or others, and traversable by others (mode 0755): the proxy container reads the hash through it." >&2; exit 1
fi
if [ -e "$out" ] || [ -L "$out" ]; then
  [ "${KAYAS_BASIC_REPLACE:-}" = 1 ] || { echo "make-basic.sh: $out already exists. To replace it run with KAYAS_BASIC_REPLACE=1." >&2; exit 1; }
  [ -L "$out" ] && { echo "make-basic.sh: $out is a link: refused" >&2; exit 1; }
fi
if [ "${KAYAS_BASIC_BATCH:-}" != 1 ] && { [ ! -t 0 ] || [ ! -t 2 ]; }; then
  echo "make-basic.sh: no terminal. Run it in an interactive terminal (hidden prompts), or set KAYAS_BASIC_BATCH=1 and supply the three lines on stdin." >&2; exit 1
fi
saved_tty=""
restore_tty() { [ -z "$saved_tty" ] || stty "$saved_tty" </dev/tty 2>/dev/null || true; }
trap restore_tty EXIT INT TERM
# Echo is switched OFF before the prompt is printed (not by `read -s` after it): a fast typist, a paste or a slow machine cannot beat the switch.
read_secret() { # prompt var : hidden when interactive
  local v
  if [ "${KAYAS_BASIC_BATCH:-}" = 1 ]; then IFS= read -r v || v=""
  else
    saved_tty="$(stty -g </dev/tty)"
    stty -echo </dev/tty
    printf '%s' "$1" >&2
    IFS= read -r v </dev/tty || v=""
    stty "$saved_tty" </dev/tty 2>/dev/null || true
    saved_tty=""
    printf '\n' >&2
  fi
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
trap 'restore_tty; rm -f -- "$tmp"' EXIT
hash="$(printf '%s\n' "$pw1" | docker run --rm -i --network none --read-only "$caddy_image" caddy hash-password 2>/dev/null | tail -n1)"
unset pw1 pw2
[[ "$hash" =~ ^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$ ]] || { echo "make-basic.sh: Caddy did not return a bcrypt hash; nothing was written" >&2; exit 1; }
{
  echo '# Basic Auth gate of the staging proxy: a bcrypt HASH only. Made by scripts/staging/make-basic.sh. Never commit this file.'
  echo 'basic_auth bcrypt "KAYAS staging" {'
  printf '\t%s %s\n' "$user" "$hash"
  echo '}'
} > "$tmp"
chmod 644 "$tmp"
mv -f -- "$tmp" "$out"
trap restore_tty EXIT
echo "make-basic.sh: wrote $out (mode 0644: a bcrypt hash only; the hardened proxy has to be able to read it). The password is not stored anywhere on this host."
# Rotation: Caddy reads the hash only at start (admin API off), so a RUNNING proxy keeps accepting the OLD password until it is recreated. A new file is
# also a new inode. The proxy is therefore recreated through the validated wrapper, and the rotation is reported as applied ONLY when the wrapper has
# confirmed a running, healthy proxy afterwards. Any doubt is an incomplete rotation (non-zero exit), never a silent success (R21-01).
if [ -r .env.staging ] && [ -x scripts/staging/dc.sh ]; then
  not_applied() {
    echo "make-basic.sh: rotation NOT applied: the old Basic credential may still work; do not rely on it; verify with the curl checks of docs/STAGING-VPS.md (section 11, rotation). $1" >&2
    exit 1
  }
  # a FAILED status query is not the same as "no proxy": only a successful query with an empty answer means the proxy is not running
  if ! running="$(./scripts/staging/dc.sh ps -q proxy)"; then
    not_applied "The status of the proxy could not be read (./scripts/staging/dc.sh ps proxy failed)."
  fi
  if [ -n "$running" ]; then
    echo "make-basic.sh: the proxy is running: recreating it so that it reads the new hash."
    ./scripts/staging/dc.sh up -d --force-recreate --wait proxy >/dev/null || not_applied "The proxy could not be recreated (look at: ./scripts/staging/dc.sh logs --tail 30 proxy)."
    if ! state="$(./scripts/staging/dc.sh ps --format '{{.Service}} {{.State}} {{.Health}}' proxy)" || [ "$state" != "proxy running healthy" ]; then
      not_applied "After the recreation the proxy is not confirmed running and healthy."
    fi
    echo "make-basic.sh: rotation applied: the proxy was recreated and is running and healthy. Confirm from outside: the OLD password must give 401, the NEW one 200 or 307 (docs/STAGING-VPS.md, section 11)."
  else
    echo "make-basic.sh: the status query succeeded and no proxy is running; ./scripts/staging/up.sh will start it with the new hash."
  fi
else
  echo "make-basic.sh: no staging stack is configured here (.env.staging or dc.sh missing): nothing to recreate." >&2
fi
