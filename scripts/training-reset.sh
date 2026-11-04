#!/usr/bin/env bash
# `pnpm reset:training` for the iMac: wipes the training database and seeds it again with NEW accounts. Stops the app first.
set -euo pipefail
cd "$(dirname "$0")/.."
dc=./scripts/training/dc.sh
read -r -p "This erases everything entered in the training instance and creates new passwords. Type RESET to continue: " answer
[ "$answer" = "RESET" ] || { echo "cancelled"; exit 1; }
$dc stop app
./scripts/training/ops.sh reset-training
$dc up -d app
echo "Reset done. Read the new accounts once with ./scripts/training/show-accounts.sh"
