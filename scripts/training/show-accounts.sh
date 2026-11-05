#!/usr/bin/env bash
# Shows training credentials, ONE trainee's block at a time (R11-10): hand each person their own line in person, never the whole list.
#   ./scripts/training/show-accounts.sh                 the list of accounts (names only, no secret)
#   ./scripts/training/show-accounts.sh chauffeur       the block(s) whose label or login contains this text (case-insensitive)
#   ./scripts/training/show-accounts.sh --all           everything, secrets included: only when you really need it, never recorded or sent
# Then clear the screen and its history (Command-K in Terminal). Do not redirect the output to a file, do not run it under `script`, do not
# screen-record. A reset writes new credentials.
set -euo pipefail
file=/app/out/training-accounts.local.txt
dc="$(dirname "$0")/dc.sh"
read_file() { "$dc" run --rm -T ops cat "$file"; }
# The account blocks are the paragraphs that carry an e-mail or a code line.
case "${1:-}" in
  "")
    read_file | awk 'BEGIN{RS="";FS="\n"} /  (e-mail|code) +:/ {print "  " $1}'
    echo "Give a name or a login to see one account's secret: show-accounts.sh <text>" >&2
    ;;
  --all)
    echo "WARNING: every secret is about to be printed. Do not record, redirect or send this output." >&2
    read_file
    ;;
  --*)
    echo "show-accounts.sh: unknown option $1" >&2
    exit 2
    ;;
  *)
    q=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
    out=$(read_file | awk -v q="$q" 'BEGIN{RS="";ORS="\n\n";FS="\n"} /  (e-mail|code) +:/ && index(tolower($0), q) {print}')
    [ -n "$out" ] || { echo "show-accounts.sh: no account matches \"$1\"" >&2; exit 1; }
    printf '%s\n' "$out"
    ;;
esac
