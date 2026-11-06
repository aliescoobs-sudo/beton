#!/usr/bin/env bash
# Shows training credentials, ONE trainee's block at a time (R11-10): hand each person their own line in person, never the whole list.
#   ./scripts/training/show-accounts.sh                 the list of accounts (names only, no secret)
#   ./scripts/training/show-accounts.sh CH-02           the ONE block whose login or code (or e-mail before the @, or whole name) is exactly this
#                                                       (case-insensitive); zero or several matches are refused before anything secret is printed
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
    # R12-06: the selector is compared with the LABEL and the LOGIN of each block only (the e-mail or its part before the @, the driver
    # code), never with the secret line. Exactly ONE block must match exactly; zero or several are refused before anything secret is printed.
    q=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
    set +e
    read_file | awk -v q="$q" '
      BEGIN { RS = ""; FS = "\n"; n = 0 }
      /  (e-mail|code) +:/ {
        n++; block[n] = $0
        label = $1; sub(/ *\(.*$/, "", label); label = tolower(label)
        login = $2; sub(/^[^:]*: */, "", login); login = tolower(login); gsub(/ +$/, "", login)
        local = login; sub(/@.*/, "", local)
        name[n] = $1
        if (q == label || q == login || q == local) { exact++; pick = n }
        else if (index(label, q) || index(login, q)) { partial++; hint = hint "  " $1 "\n" }
      }
      END {
        if (exact == 1) { printf "%s\n", block[pick]; exit 0 }
        if (exact > 1) { print "show-accounts.sh: \"" q "\" names " exact " accounts exactly; give one unique login or code. Nothing printed." > "/dev/stderr"; exit 3 }
        if (partial > 0) { printf "show-accounts.sh: \"%s\" is not the exact login, code or name of an account but is part of %d of them; give the exact login or code:\n%sNothing printed.\n", q, partial, hint > "/dev/stderr"; exit 3 }
        print "show-accounts.sh: no account has \"" q "\" as its login, code or name. Nothing printed." > "/dev/stderr"; exit 1
      }'
    rc=$?
    set -e
    exit $rc
    ;;
esac
