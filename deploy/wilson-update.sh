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

# --- GitHub token for authenticated API calls (avoids rate limits) ---
GITHUB_TOKEN_FILE="${HOME}/.config/wilson/github-token"
if [ -f "$GITHUB_TOKEN_FILE" ]; then
  GITHUB_TOKEN=$(cat "$GITHUB_TOKEN_FILE")
  export GITHUB_TOKEN
fi

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*" >> "$LOG_FILE"; }

# --- version check + update for a service ---

check_and_update() {
  local name="$1"
  local repo="$2"
  local install_base="${HOME}/srv/${name}"
  local current_file="${install_base}/current-version"
  local cli_path="${HOME}/.local/bin/${name}"

  # Auth header for GitHub API (if token available)
  local auth_header=()
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    auth_header=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
  fi

  # Read current version
  local current=""
  if [ -f "$current_file" ]; then
    current=$(cat "$current_file")
  fi

  # Fetch latest tag from GitHub
  local release_json
  release_json=$(curl -fsSL "${auth_header[@]}" "https://api.github.com/repos/${repo}/releases/latest" 2>/dev/null) || {
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
  # Wilson needs SKIP_LAUNCHAGENT_RELOAD=1 because the updater LaunchAgent is
  # separate from the daemon — we don't want install.sh to reload it.
  local install_url="https://github.com/${repo}/releases/latest/download/install.sh"
  local install_env="GITHUB_TOKEN=${GITHUB_TOKEN:-}"
  if [ "$name" = "wilson" ]; then
    install_env="SKIP_LAUNCHAGENT_RELOAD=1 ${install_env}"
  fi
  curl -fsSL "${auth_header[@]}" "$install_url" 2>/dev/null | env ${install_env} bash >> "$LOG_FILE" 2>&1 || {
    log "ERROR: ${name}: install.sh failed"
    return 1
  }

  # Restart daemon if CLI exists
  if [ -x "$cli_path" ]; then
    "$cli_path" restart >> "$LOG_FILE" 2>&1 || {
      log "WARN: ${name}: restart failed, retrying in 3s..."
      sleep 3
      "$cli_path" restart >> "$LOG_FILE" 2>&1 || {
        log "ERROR: ${name}: restart failed on retry"
        return 1
      }
    }

    # Verify health after restart (skip for wilson — restart already verifies)
    if [ "$name" != "wilson" ]; then
      sleep 2
      "$cli_path" health >> "$LOG_FILE" 2>&1 || {
        log "WARN: ${name}: post-restart health check failed"
      }
    fi
  fi

  log "INFO: ${name}: updated to ${latest}"
}

# --- main ---

verify_launch_agent() {
  local uid plist
  uid=$(id -u)
  plist="${HOME}/Library/LaunchAgents/com.suyash.wilson-updater.plist"
  if ! launchctl print "gui/${uid}/com.suyash.wilson-updater" >/dev/null 2>&1; then
    log "WARN: LaunchAgent not loaded, attempting recovery reload"
    if [ -f "$plist" ]; then
      launchctl bootstrap "gui/${uid}" "$plist" || log "ERROR: LaunchAgent bootstrap failed during recovery"
      sleep 1
      if launchctl print "gui/${uid}/com.suyash.wilson-updater" >/dev/null 2>&1; then
        log "INFO: LaunchAgent recovered successfully"
      else
        log "ERROR: LaunchAgent recovery failed"
      fi
    else
      log "ERROR: LaunchAgent plist not found at ${plist}"
    fi
  fi
}

TARGET="${1:-all}"
failures=0

# Verify agent is loaded before processing
verify_launch_agent

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
  wilson)
    log "INFO: update check starting (wilson only)"
    check_and_update "wilson" "shetty4l/wilson" || (( failures++ ))
    ;;
  all)
    log "INFO: update check starting"
    # Each check is independent — failure in one does not block the others
    check_and_update "engram"  "shetty4l/engram"  || (( failures++ ))
    check_and_update "synapse" "shetty4l/synapse" || (( failures++ ))
    check_and_update "cortex"  "shetty4l/cortex"  || (( failures++ ))
    check_and_update "wilson"  "shetty4l/wilson"  || (( failures++ ))
    ;;
  *)
    echo "Usage: wilson-update.sh [engram|synapse|cortex|wilson|all]" >&2
    exit 1
    ;;
esac

log "INFO: update check complete (failures: ${failures})"
[ "$failures" -eq 0 ]
