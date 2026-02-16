#!/usr/bin/env bash
set -uo pipefail

# Wilson update orchestrator
# Runs periodically via LaunchAgent to check for updates to all services.
# Can also be invoked manually: wilson-update.sh [service]
#
# Services are checked in dependency order:
#   1. engram (dependency of other services)
#   2. synapse (model routing)
#   3. cortex (life assistant — depends on engram + synapse)
#   4. wilson (self — last, since we're running from wilson's scripts)
#
# Each service's install.sh handles the heavy lifting (download, extract,
# install deps, symlink). This script only does version comparison and
# daemon restart.

LOG_FILE="${HOME}/Library/Logs/wilson-updater.log"

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" >> "$LOG_FILE"; }

# --- version check + update for a service ---

check_and_update() {
  local name="$1"
  local repo="$2"
  local install_base="${HOME}/srv/${name}"
  local current_file="${install_base}/current-version"
  local cli_path="${HOME}/.local/bin/${name}"

  # Read current version
  local current=""
  if [ -f "$current_file" ]; then
    current=$(cat "$current_file")
  fi

  # Fetch latest tag from GitHub
  local release_json
  release_json=$(curl -fsSL "https://api.github.com/repos/${repo}/releases/latest" 2>/dev/null) || {
    log "ERROR: ${name}: failed to fetch latest release"
    return 1
  }

  local latest
  latest=$(echo "$release_json" | jq -r '.tag_name')
  if [ -z "$latest" ] || [ "$latest" = "null" ]; then
    log "ERROR: ${name}: no release tag found"
    return 1
  fi

  # Compare — exit early if up to date
  if [ "$current" = "$latest" ]; then
    return 0
  fi

  log "INFO: ${name}: new version ${latest} (current: ${current:-none})"

  # Delegate to the service's own installer
  local install_url="https://github.com/${repo}/releases/latest/download/install.sh"
  curl -fsSL "$install_url" 2>/dev/null | bash >> "$LOG_FILE" 2>&1 || {
    log "ERROR: ${name}: install.sh failed"
    return 1
  }

  # Restart daemon if CLI exists
  if [ -x "$cli_path" ]; then
    "$cli_path" restart >> "$LOG_FILE" 2>&1 || log "WARN: ${name}: restart failed"
  fi

  log "INFO: ${name}: updated to ${latest}"
}

# --- wilson self-update ---
# Separate from check_and_update because wilson is a CLI, not a daemon.
# check_and_update would attempt `wilson restart` after updating, which is
# wrong — there's no long-running wilson process to restart.

check_and_update_self() {
  local repo="shetty4l/wilson"
  local install_base="${HOME}/srv/wilson"
  local current_file="${install_base}/current-version"

  local current=""
  if [ -f "$current_file" ]; then
    current=$(cat "$current_file")
  fi

  local release_json
  release_json=$(curl -fsSL "https://api.github.com/repos/${repo}/releases/latest" 2>/dev/null) || {
    log "ERROR: wilson: failed to fetch latest release"
    return 1
  }

  local latest
  latest=$(echo "$release_json" | jq -r '.tag_name')
  if [ -z "$latest" ] || [ "$latest" = "null" ]; then
    log "ERROR: wilson: no release tag found"
    return 1
  fi

  if [ "$current" = "$latest" ]; then
    return 0
  fi

  log "INFO: wilson: new version ${latest} (current: ${current:-none})"

  local install_url="https://github.com/${repo}/releases/latest/download/install.sh"
  curl -fsSL "$install_url" 2>/dev/null | bash >> "$LOG_FILE" 2>&1 || {
    log "ERROR: wilson: install.sh failed"
    return 1
  }

  log "INFO: wilson: updated to ${latest}"
}

# --- main ---

TARGET="${1:-all}"
failures=0

case "$TARGET" in
  engram)
    log "INFO: update check starting (engram only)"
    check_and_update "engram" "shetty4l/engram" || (( failures++ ))
    ;;
  synapse)
    log "INFO: update check starting (synapse only)"
    check_and_update "synapse" "shetty4l/synapse" || (( failures++ ))
    ;;
  cortex)
    log "INFO: update check starting (cortex only)"
    check_and_update "cortex" "shetty4l/cortex" || (( failures++ ))
    ;;
  self)
    log "INFO: update check starting (wilson self)"
    check_and_update_self || (( failures++ ))
    ;;
  all)
    log "INFO: update check starting"
    # Each check is independent — failure in one does not block the others
    check_and_update "engram"  "shetty4l/engram"  || (( failures++ ))
    check_and_update "synapse" "shetty4l/synapse" || (( failures++ ))
    check_and_update "cortex"  "shetty4l/cortex"  || (( failures++ ))
    check_and_update_self                          || (( failures++ ))
    ;;
  *)
    echo "Usage: wilson-update.sh [engram|synapse|cortex|self|all]" >&2
    exit 1
    ;;
esac

log "INFO: update check complete (failures: ${failures})"
[ "$failures" -eq 0 ]
