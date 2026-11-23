#!/usr/bin/env bash
# Timer entry point: load Node 22 (nvm) and run the automatic job.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh" >/dev/null; nvm use --silent 22 >/dev/null; fi
# Download the latest results first, so a new check-in is judged on this run
# instead of waiting for the next backup (a failed download only means this
# run uses the previous copy).
./scripts/backup-from-render.sh >/dev/null 2>&1 || true
exec node assessment/auto/run-auto.js "$@"
