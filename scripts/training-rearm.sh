#!/usr/bin/env bash
# Re-arms the training day on the iMac (under a minute): today's orders, the drivers' rotations, quotes, an order to cancel, a delivery to
# receive, a low-stock alert. Accounts and passwords are NOT touched. Run it each morning before the session.
set -euo pipefail
cd "$(dirname "$0")/.."
./scripts/training/ops.sh rearm-training
