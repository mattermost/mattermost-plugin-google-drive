#!/usr/bin/env bash
# Runs the @visual specs (specs/visual.spec.ts) on their own throwaway compose project: a pinned
# Mattermost release on port 8076, the fake Google, and a dockerized Playwright browser
# (docker-compose.visual.yml), so the screenshots match on any machine and in CI. It never touches
# the normal stack (npm run server:up), which can keep running. Extra arguments go to
# `playwright test`, e.g. --update-snapshots. Adapted from mattermost-plugin-jira
# e2e/playwright/scripts/visual.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

# Baselines are tied to this exact server build; bump it together with test:visual-update-snapshots.
export MM_IMAGE=mattermost/mattermost-enterprise-edition:12.0.1
export MM_PORT=8076
export FAKE_GOOGLE_PORT=8086
export E2E_DB_PORT=5436
export VISUAL_BROWSER_PORT=3337
# The created-file post prints the file's created time.
export FAKE_FIXED_CREATED_TIME=2026-01-15T09:30:00.000Z
export PLAYWRIGHT_VERSION
PLAYWRIGHT_VERSION=$(node -p "require('@playwright/test/package.json').version")
if [ -z "${VISUAL_BROWSER_PLATFORM:-}" ]; then
  case "$(uname -m)" in
    arm64 | aarch64) VISUAL_BROWSER_PLATFORM=linux/arm64 ;;
    *) VISUAL_BROWSER_PLATFORM=linux/amd64 ;;
  esac
fi
export VISUAL_BROWSER_PLATFORM

# What global_setup.ts and playwright.config.ts read.
export E2E_GOOGLE=fake
export E2E_SERVER=compose
export PW_BASE_URL="http://localhost:$MM_PORT"
export PW_VISUAL_BROWSER_WS="ws://127.0.0.1:$VISUAL_BROWSER_PORT/"

compose() {
  docker compose -p gdrive-plugin-e2e-visual -f docker-compose.yml -f docker-compose.visual.yml --profile fake "$@"
}

cleanup() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    mkdir -p logs
    compose logs --no-color > logs/visual-containers.log 2>&1 || true
    echo "Container logs: e2e/logs/visual-containers.log"
  fi
  compose down -v >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

echo "Starting the visual stack ($MM_IMAGE at $PW_BASE_URL, browser $VISUAL_BROWSER_PLATFORM)"
compose up -d --wait

npx playwright test --grep @visual "$@"
