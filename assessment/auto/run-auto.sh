#!/usr/bin/env bash
# Timer entry point: load Node 22 (nvm) and run the automatic job.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh" >/dev/null; nvm use --silent 22 >/dev/null; fi
exec node assessment/auto/run-auto.js "$@"
