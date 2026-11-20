#!/usr/bin/env bash
# Downloads the results workbook from the Render trial (DEV_MOCK) and keeps a
# copy in the local backup folder. Run on a timer (see scripts/systemd/).
#
#   RENDER_URL   service address (default https://ai-adoption-survey.onrender.com)
#   BACKUP_DIR   where copies go  (default <project>/backup)
#
# A new timestamped file is written only when the workbook changed.
# "render-results-latest.xlsx" always holds the most recent download.
# Old copies are never deleted: after a Render restart the server starts a new,
# empty file, so earlier rows only exist in the older timestamped copies.
#
# Only works while Render runs with DEV_MOCK=true (trial sign-in). With the
# real Entra setup the results are already in OneDrive/SharePoint.
set -euo pipefail

RENDER_URL="${RENDER_URL:-https://ai-adoption-survey.onrender.com}"
RENDER_URL="${RENDER_URL%/}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backup}"
LATEST="$BACKUP_DIR/render-results-latest.xlsx"
LOG="$BACKUP_DIR/backup.log"

mkdir -p "$BACKUP_DIR"
umask 077
log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG"; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
jar="$work/cookies"
file="$work/results.xlsx"

# Wake the service (a cold start on the Free plan takes up to a minute).
if ! curl -fsS --max-time 120 --retry 2 --retry-delay 10 "$RENDER_URL/healthz" -o /dev/null; then
  log "ERROR service not reachable at $RENDER_URL"
  exit 1
fi

# Trial sign-in as admin, then download the workbook with that session.
curl -fsS --max-time 60 -c "$jar" -b "$jar" "$RENDER_URL/auth/signin?as=admin" -o /dev/null
code="$(curl -sS --max-time 120 -b "$jar" -w '%{http_code}' -o "$file" "$RENDER_URL/admin/api/download" || true)"

if [ "$code" = "501" ]; then
  log "SKIP Render has no EXCEL_LOCAL_PATH set, so there is no file to download"
  exit 0
fi
# A valid .xlsx is a zip file starting with "PK". Anything else means there are
# no submissions since the last restart (no file yet) or the request failed.
if [ "$code" != "200" ] || [ ! -s "$file" ] || [ "$(head -c2 "$file")" != "PK" ]; then
  log "SKIP no workbook available yet (HTTP $code)"
  exit 0
fi

# Render restarted and lost submissions we already had? Send the previous copy
# back (Render merges it with anything submitted since) and keep the previous
# copy as the latest; the next run downloads the restored file.
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null && nvm use --silent 22 >/dev/null || true
fi
if command -v node >/dev/null && [ -d "$PROJECT_DIR/node_modules/exceljs" ] && [ -f "$LATEST" ]; then
  set +e
  msg="$(RENDER_URL="$RENDER_URL" node "$PROJECT_DIR/scripts/restore-if-needed.js" "$file" "$LATEST" 2>&1)"; rc=$?
  set -e
  if [ $rc -eq 10 ]; then log "$msg"; exit 0; fi
  # A restore was needed but did not work: keep the previous (fuller) copy as
  # the latest and try again next run, instead of saving the emptier download.
  if [ $rc -ne 0 ]; then log "${msg:-RESTORE check failed}; keeping the previous copy, will retry"; exit 0; fi
fi

if [ -f "$LATEST" ] && cmp -s "$file" "$LATEST"; then
  log "OK unchanged"
  exit 0
fi

stamp="$(date '+%Y%m%d-%H%M%S')"
cp "$file" "$BACKUP_DIR/render-results-$stamp.xlsx"
cp "$file" "$LATEST"
log "SAVED render-results-$stamp.xlsx ($(stat -c %s "$file") bytes)"

# Rebuild the review report (backup/AI Survey Review.xlsx). Needs Node and the
# project's node_modules (npm ci); timers do not load nvm, so try it here.
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null && nvm use --silent 22 >/dev/null || true
fi
if command -v node >/dev/null && [ -d "$PROJECT_DIR/node_modules/exceljs" ]; then
  if node "$PROJECT_DIR/scripts/make-review-report.js" "$LATEST" "$BACKUP_DIR/AI Survey Review.xlsx" >/dev/null 2>"$work/report.err"; then
    log "REPORT AI Survey Review.xlsx updated"
  else
    log "REPORT failed: $(head -c 200 "$work/report.err")"
  fi
else
  log "REPORT skipped (run npm ci in $PROJECT_DIR to enable)"
fi
